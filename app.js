(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var verifyForm = $('verify-form');
  var orderForm = $('order-form');
  var done = $('done');
  var msg = $('msg');
  var creds = null;      // 只存在記憶體，不寫入 localStorage / cookie
  var stores = [];       // 目前地區的門市清單
  var picked = null;     // 選中的門市 {id, name, addr}

  if (cfg.PROOF_HINT) $('proof-hint').textContent = cfg.PROOF_HINT;

  function show(el) { [verifyForm, orderForm, done].forEach(function (x) { x.hidden = x !== el; }); }
  function say(text, ok) { msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  function busy(btn, on, label) { btn.disabled = on; btn.textContent = on ? '處理中…' : label; }
  function val(id) { return $(id).value.trim(); }
  function opt(value, text) { var o = document.createElement('option'); o.value = value; o.textContent = text; return o; }

  function call(payload) {
    if (!cfg.API_URL || cfg.API_URL.indexOf('/exec') === -1) {
      return Promise.resolve({ ok: false, msg: '表單尚未設定完成，請聯絡主辦。' });
    }
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 25000);
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

  // 顯示已存的資料，並把它預先放進第 2 步的表單，方便直接修改
  function showSaved(s) {
    var dl = $('summary');
    dl.replaceChildren();
    [['門市', (s.storeName || '') + ' 門市'], ['店號', s.storeId], ['地址', s.storeAddr], ['收件人', s.recipient]].forEach(function (p) {
      var dt = document.createElement('dt'); dt.textContent = p[0];
      var dd = document.createElement('dd'); dd.textContent = p[1] || '';
      dl.append(dt, dd);
    });
    if (s.storeId) {
      var st = { id: String(s.storeId), name: String(s.storeName || ''), addr: String(s.storeAddr || '') };
      if (!stores.some(function (x) { return x.id === st.id; })) stores = [st].concat(stores);
      var sel = $('store');
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === st.id; })) {
        sel.insertBefore(opt(st.id, st.name + '｜' + st.addr), sel.options[1] || null);
      }
      sel.disabled = false;
      sel.value = st.id;
      pick(st);
    }
    if (s.recipient) $('recipient').value = s.recipient;
    show(done);
  }

  /* ---------- 第 1 步：驗證 ---------- */

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
        $('welcome').textContent = '你好，' + res.nickname + '！請選擇取貨門市。';
        if (res.existing && res.existing.storeId) {
          // 之前填過：直接顯示原本的資料，可按「修改資料」修改
          showSaved(res.existing);
          say('你之前已經填過囉，以下是目前的資料。', true);
          return;
        }
        show(orderForm);
        $('city').focus();
      })
      .finally(function () { busy(btn, false, '驗證'); });
  });

  /* ---------- 第 2 步：找門市 ---------- */

  (window.TW_TOWNS || []).forEach(function (c) { $('city').append(opt(c[0], c[0])); });

  function setTab(area) {
    $('tab-area').classList.toggle('active', area);
    $('tab-name').classList.toggle('active', !area);
    $('tab-area').setAttribute('aria-selected', String(area));
    $('tab-name').setAttribute('aria-selected', String(!area));
    $('pane-area').hidden = !area;
    $('pane-name').hidden = area;
    resetStores(area ? '請先選擇地區' : '請先輸入店名或店號搜尋');
    if (!area) $('q').focus();
  }
  $('tab-area').addEventListener('click', function () { setTab(true); });
  $('tab-name').addEventListener('click', function () { setTab(false); });

  function resetStores(placeholder) {
    stores = [];
    var sel = $('store');
    sel.replaceChildren(opt('', placeholder));
    sel.disabled = true;
    $('store-count').textContent = '';
    pick(null);
  }

  function renderStores() {
    var kw = $('pane-area').hidden ? '' : val('filter').replace(/\s/g, '').replace(/台/g, '臺');
    var list = stores.filter(function (s) {
      if (!kw) return true;
      var hay = (s.name + s.addr).replace(/\s/g, '').replace(/台/g, '臺');
      return hay.indexOf(kw) !== -1;
    });
    var sel = $('store');
    sel.replaceChildren(opt('', list.length ? '請選擇門市（共 ' + list.length + ' 間）' : '找不到符合的門市'));
    list.forEach(function (s) { sel.append(opt(s.id, s.name + '｜' + s.addr)); });
    sel.disabled = !list.length;
    $('store-count').textContent = kw && stores.length ? '從 ' + stores.length + ' 間中篩選出 ' + list.length + ' 間' : '';
    pick(null);
  }

  function loadStores(payload) {
    if (!creds) return show(verifyForm);
    say('');
    var sel = $('store');
    sel.replaceChildren(opt('', '查詢中…'));
    sel.disabled = true;
    pick(null);
    var p = Object.assign({ action: 'stores', nickname: creds.nickname, proof: creds.proof }, payload);
    return call(p).then(function (res) {
      if (!res || !res.ok) { resetStores('查詢失敗'); return say((res && res.msg) || '查詢失敗，請再試一次。'); }
      stores = Array.isArray(res.stores) ? res.stores : [];
      renderStores();
    });
  }

  $('city').addEventListener('change', function () {
    var town = $('town');
    var row = (window.TW_TOWNS || []).filter(function (c) { return c[0] === $('city').value; })[0];
    town.replaceChildren(opt('', row ? '請選擇' : '請先選縣市'));
    if (row) row[1].split(',').forEach(function (t) { town.append(opt(t, t)); });
    town.disabled = !row;
    $('filter').value = '';
    $('filter').disabled = true;
    resetStores('請先選擇鄉鎮市區');
  });

  $('town').addEventListener('change', function () {
    if (!$('town').value) return resetStores('請先選擇鄉鎮市區');
    $('filter').value = '';
    $('filter').disabled = false;
    loadStores({ city: $('city').value, town: $('town').value });
  });

  $('filter').addEventListener('input', renderStores);

  function doSearch() {
    var q = val('q').replace(/\s/g, '');
    if (!q) return say('請輸入店名或店號。');
    var btn = $('q-btn');
    busy(btn, true, '搜尋');
    loadStores({ q: q }).finally(function () { busy(btn, false, '搜尋'); });
  }
  $('q-btn').addEventListener('click', doSearch);
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  function pick(s) {
    picked = s;
    $('picked').hidden = !s;
    $('picked-name').textContent = s ? s.name + ' 門市（店號 ' + s.id + '）' : '';
    $('picked-addr').textContent = s ? s.addr : '';
  }
  $('store').addEventListener('change', function () {
    var id = $('store').value;
    pick(stores.filter(function (s) { return s.id === id; })[0] || null);
  });

  /* ---------- 送出 ---------- */

  orderForm.addEventListener('submit', function (e) {
    e.preventDefault();
    say('');
    if (!creds) return show(verifyForm);
    if (!picked) return say('請先選擇取貨門市。');
    var recipient = val('recipient');
    if (recipient.length < 2) return say('請填寫收件人姓名。');
    var btn = $('submit-btn');
    busy(btn, true, '送出');
    call({
      action: 'submit',
      nickname: creds.nickname, proof: creds.proof, website: $('website').value,
      storeId: picked.id, recipient: recipient,
    })
      .then(function (res) {
        if (!res || !res.ok) return say((res && res.msg) || '送出失敗。');
        showSaved(res.saved || {});
        say(res.updated ? '已更新為最新資料。' : '送出成功！', true);
      })
      .finally(function () { busy(btn, false, '送出'); });
  });

  $('back-btn').addEventListener('click', function () { creds = null; say(''); show(verifyForm); });
  // 修改資料：回到門市與收件人頁面，保留剛才填的內容（驗證資料只存在這個分頁的記憶體裡）
  $('again-btn').addEventListener('click', function () {
    say('');
    if (!creds) { show(verifyForm); return $('nickname').focus(); }
    show(orderForm);
    $('store').focus();
  });
})();
