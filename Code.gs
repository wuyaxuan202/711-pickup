/**
 * 7-11 收件資料表單 — Google Apps Script 後端
 *
 * 安全設計重點：
 *  1. 贊助名單只存在你私人的試算表，永遠不會傳到網頁或 GitHub。
 *  2. 驗證在伺服器端做；失敗訊息一律相同，不透露「暱稱存不存在」。
 *  3. 同一暱稱連續驗證失敗 5 次就鎖 30 分鐘，防止暴力猜測贊助資料。
 *  4. 所有輸入都做格式檢查與長度限制，並防止試算表公式注入。
 *  5. 寫入時加鎖，避免兩人同時送出互相覆蓋。
 *  6. 寫入的暱稱取自名單本身，而不是使用者輸入的字串。
 */

const CONFIG = {
  SHEET_SPONSORS: '贊助名單', // A欄：群組暱稱、B欄：驗證資料（例如匯款帳號末五碼）
  SHEET_ORDERS: '收件資料',
  SHEET_LOG: '紀錄',
  // 截止時間（台灣時間），留空代表不截止。例：'2026-12-31T23:59:59+08:00'
  DEADLINE: '',
  MAX_FAILS_PER_NICK: 5,
  LOCK_MINUTES: 30,
  MAX_REQUESTS_PER_MINUTE: 120, // 全站每分鐘上限，防止灌爆
  MAX_BODY_BYTES: 2000,
};

const ORDER_HEADERS = ['群組暱稱', '店號', '門市名稱', '收件人姓名', '首次送出', '最後更新', '修改次數'];
const GENERIC_FAIL = '暱稱或驗證資料不正確，請確認後再試。';

/* ---------------- 進入點 ---------------- */

function doGet() {
  return json_({ ok: true, service: '711-pickup' });
}

function doPost(e) {
  try {
    return json_(handle_(e));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, msg: '系統發生錯誤，請稍後再試。' });
  }
}

function handle_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') {
    return { ok: false, msg: '請求格式錯誤。' };
  }
  if (e.postData.contents.length > CONFIG.MAX_BODY_BYTES) {
    return { ok: false, msg: '請求內容過大。' };
  }
  if (!globalRateOk_()) {
    return { ok: false, msg: '目前送出人數較多，請一分鐘後再試。' };
  }
  if (CONFIG.DEADLINE && Date.now() > new Date(CONFIG.DEADLINE).getTime()) {
    return { ok: false, msg: '填寫時間已截止，如需協助請聯絡主辦。' };
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return { ok: false, msg: '請求格式錯誤。' };
  }
  if (!body || typeof body !== 'object') return { ok: false, msg: '請求格式錯誤。' };

  // 機器人陷阱欄位：真人看不到，有值就當作機器人
  if (body.website) return { ok: false, msg: GENERIC_FAIL };

  const nickRaw = str_(body.nickname);
  const proofRaw = str_(body.proof);
  if (!nickRaw || !proofRaw) return { ok: false, msg: '請填寫暱稱與驗證資料。' };
  if (nickRaw.length > 40 || proofRaw.length > 40) return { ok: false, msg: GENERIC_FAIL };

  const nickKey = normNick_(nickRaw);
  const failKey = 'f:' + sha256_(nickKey);
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_FAILS_PER_NICK) {
    return { ok: false, msg: '驗證失敗次數過多，請 ' + CONFIG.LOCK_MINUTES + ' 分鐘後再試，或聯絡主辦。' };
  }

  // 1) 驗證身份
  const sponsor = findSponsor_(nickKey, proofRaw);
  if (!sponsor) {
    cache.put(failKey, String(fails + 1), CONFIG.LOCK_MINUTES * 60);
    Utilities.sleep(400 + Math.floor(Math.random() * 400)); // 拖慢暴力嘗試
    return { ok: false, msg: GENERIC_FAIL };
  }
  cache.remove(failKey);

  // 只驗證、不送出（前端第一步用）
  if (body.action === 'verify') {
    return { ok: true, verified: true, nickname: sponsor.nickname };
  }

  // 2) 驗證收件資料
  const v = validateOrder_(body);
  if (!v.ok) return v;

  // 3) 寫入（加鎖）
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, msg: '系統忙碌，請稍後再試。' };
  try {
    const updated = upsertOrder_(sponsor.nickname, v.data);
    log_(updated ? '更新' : '新增', sponsor.nickname);
    return {
      ok: true,
      updated: updated,
      saved: { storeId: v.data.storeId, storeName: v.data.storeName, recipient: v.data.recipient },
    };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- 驗證 ---------------- */

function findSponsor_(nickKey, proofRaw) {
  const sh = sheet_(CONFIG.SHEET_SPONSORS);
  const rows = sh.getDataRange().getValues();
  const proofKey = normProof_(proofRaw);
  let match = null;
  for (let i = 1; i < rows.length; i++) { // 第 1 列是標題
    const nick = String(rows[i][0] || '').trim();
    const proof = String(rows[i][1] || '').trim();
    if (!nick || !proof) continue;
    // 掃完整份名單，不提早跳出，避免用回應時間判斷暱稱是否存在
    const nickOk = safeEqual_(normNick_(nick), nickKey);
    const proofOk = safeEqual_(normProof_(proof), proofKey);
    if (nickOk && proofOk && !match) match = { nickname: nick, row: i + 1 };
  }
  return match;
}

function validateOrder_(body) {
  const storeId = toHalfWidth_(str_(body.storeId)).replace(/\s/g, '');
  let storeName = str_(body.storeName).replace(/\s+/g, '');
  const recipient = str_(body.recipient).replace(/\s+/g, ' ');

  if (!/^\d{6}$/.test(storeId)) {
    return { ok: false, msg: '店號應為 6 位數字（可在 7-ELEVEN 電子地圖查詢）。' };
  }
  storeName = storeName.replace(/門市$/, '');
  if (storeName.length < 1 || storeName.length > 20 || !/^[\p{Script=Han}A-Za-z0-9]+$/u.test(storeName)) {
    return { ok: false, msg: '門市名稱格式不正確，請填寫中文店名，例如「鑫忠孝」。' };
  }
  if (recipient.length < 2 || recipient.length > 20 || !/^[\p{L}][\p{L}\s.·．‧]*$/u.test(recipient)) {
    return { ok: false, msg: '收件人姓名請填寫真實姓名（需與取件證件相符），不可含數字或符號。' };
  }
  return { ok: true, data: { storeId: storeId, storeName: storeName, recipient: recipient } };
}

/* ---------------- 寫入 ---------------- */

function upsertOrder_(nickname, d) {
  const sh = sheet_(CONFIG.SHEET_ORDERS);
  if (sh.getLastRow() === 0) sh.appendRow(ORDER_HEADERS);
  const now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  const last = sh.getLastRow();
  const key = normNick_(nickname);

  if (last >= 2) {
    const nicks = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < nicks.length; i++) {
      if (normNick_(nicks[i][0]) === key) {
        const r = i + 2;
        const count = Number(sh.getRange(r, 7).getValue() || 0);
        sh.getRange(r, 2, 1, 6).setValues([[
          "'" + d.storeId, cell_(d.storeName), cell_(d.recipient),
          sh.getRange(r, 5).getValue(), now, count + 1,
        ]]);
        return true;
      }
    }
  }
  sh.appendRow([cell_(nickname), "'" + d.storeId, cell_(d.storeName), cell_(d.recipient), now, now, 0]);
  return false;
}

function log_(action, nickname) {
  const sh = sheet_(CONFIG.SHEET_LOG);
  if (sh.getLastRow() === 0) sh.appendRow(['時間', '動作', '群組暱稱']);
  if (sh.getLastRow() > 5000) return; // 避免被灌爆
  sh.appendRow([Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'), action, cell_(nickname)]);
}

/* ---------------- 工具 ---------------- */

function globalRateOk_() {
  const cache = CacheService.getScriptCache();
  const key = 'g:' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  return n <= CONFIG.MAX_REQUESTS_PER_MINUTE;
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function str_(v) {
  if (typeof v !== 'string') return '';
  // 去掉控制字元與零寬字元
  return v.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
}

function toHalfWidth_(s) {
  return s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
}

function normNick_(s) {
  return String(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normProof_(s) {
  return String(s).normalize('NFKC').replace(/[\s\-_.,]/g, '').toLowerCase();
}

// 防止試算表公式注入（=、+、-、@ 開頭的內容會被當成公式）
function cell_(s) {
  s = String(s);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function safeEqual_(a, b) {
  const x = sha256_(a), y = sha256_(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function sha256_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- 第一次設定用（在編輯器手動執行一次） ---------------- */

function setup() {
  const sp = sheet_(CONFIG.SHEET_SPONSORS);
  if (sp.getLastRow() === 0) sp.appendRow(['群組暱稱', '驗證資料']);
  const od = sheet_(CONFIG.SHEET_ORDERS);
  if (od.getLastRow() === 0) od.appendRow(ORDER_HEADERS);
  // 店號、驗證資料欄設成純文字，避免開頭的 0 被吃掉
  sp.getRange('B:B').setNumberFormat('@');
  od.getRange('B:B').setNumberFormat('@');
  sheet_(CONFIG.SHEET_LOG);
}
