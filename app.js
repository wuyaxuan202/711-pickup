(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var verifyForm = $('verify-form');
  var orderForm = $('order-form');
  var done = $('done');
  var msg = $('msg');
  var creds = null; // 只存在記憶體，不寫入 localStorage / cookie

  if (cfg.PROOF_HINT) $('proof-hint').textContent = cfg.PROOF_HINT;

  function show(el) { [verifyForm, orderForm, done].forEach(function (x) { x.hidden = x !== el; }); }
  function say(text, ok) { msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  function busy(btn, on, label) { btn.disabled = on; btn.textContent = on ? '處理中…' : label; }

  function call(payload) {
    if (!cfg.API_URL || cfg.API_URL.indexOf('/exec') === -1 || cfg.API_URL.indexOf('請換成') !== -1) {
      return Promise.resolve({ ok: false, msg: '表單尚未設定完成，請聯絡主辦。' });
    }
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 20000);
    return fetch(cfg.API_URL, {
      method: 'POST',
      // text/plain 讓瀏覽器不用先送 CORS 預檢，Apps Script 才收得到
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, msg: '連線失敗，請檢查網路後再試。' }; })
      .finally(function () { clearTimeout(t); });
  }

  function val(id) { return $(id).value.trim(); }

  verifyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    say('');
    var nickname = val('nickname'), proof = val('proof');
    if (!nickname || !proof) return say('請填寫暱稱與驗證資料。');
    var btn = $('verify-btn');
    busy(btn, true, '驗證');
    call({ action: 'verify', nickname: nickname, proof: proof, website: $('website').value })
      .then(function (res) {
        if (!res || !res.ok) return say((res && res.msg) || '驗證失敗。');
        creds = { nickname: nickname, proof: proof };
        $('welcome').textContent = '你好，' + res.nickname + '！請填寫收件門市。';
        show(orderForm);
        $('storeId').focus();
      })
      .finally(function () { busy(btn, false, '驗證'); });
  });

  orderForm.addEventListener('submit', function (e) {
    e.preventDefault();
    say('');
    if (!creds) return show(verifyForm);
    var storeId = val('storeId').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    var storeName = val('storeName'), recipient = val('recipient');
    if (!/^\d{6}$/.test(storeId)) return say('店號應為 6 位數字。');
    if (!storeName) return say('請填寫門市名稱。');
    if (recipient.length < 2) return say('請填寫收件人姓名。');
    var btn = $('submit-btn');
    busy(btn, true, '送出');
    call({
      action: 'submit',
      nickname: creds.nickname, proof: creds.proof, website: $('website').value,
      storeId: storeId, storeName: storeName, recipient: recipient,
    })
      .then(function (res) {
        if (!res || !res.ok) return say((res && res.msg) || '送出失敗。');
        var s = res.saved || {};
        var dl = $('summary');
        dl.replaceChildren();
        [['店號', s.storeId], ['門市', (s.storeName || '') + ' 門市'], ['收件人', s.recipient]].forEach(function (p) {
          var dt = document.createElement('dt'); dt.textContent = p[0];
          var dd = document.createElement('dd'); dd.textContent = p[1] || '';
          dl.append(dt, dd);
        });
        say(res.updated ? '已更新為最新資料。' : '送出成功！', true);
        creds = null;
        $('proof').value = '';
        show(done);
      })
      .finally(function () { busy(btn, false, '送出'); });
  });

  $('back-btn').addEventListener('click', function () { creds = null; say(''); show(verifyForm); });
  $('again-btn').addEventListener('click', function () {
    orderForm.reset(); say(''); show(verifyForm); $('nickname').focus();
  });
})();
