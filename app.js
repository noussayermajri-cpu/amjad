/* تطبيق الأمجاد – واجهة PWA بسيطة دون مكتبات خارجية */
(function () {
  'use strict';
  var API = window.AMJAD_API_URL;
  var $app = document.getElementById('app');
  var LS = window.localStorage;

  // ---------- تخزين محلي ----------
  function get(k, d) { try { var v = LS.getItem('amjad_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function set(k, v) { try { LS.setItem('amjad_' + k, JSON.stringify(v)); } catch (e) {} }
  function del(k) { try { LS.removeItem('amjad_' + k); } catch (e) {} }

  var state = { token: get('token', ''), user: get('user', null), menu: get('menu', null), sending: false };

  // ---------- أدوات ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function h(html) { $app.innerHTML = html; window.scrollTo(0, 0); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function toast(msg, ms) {
    var t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 3000);
  }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString('ar-SA-u-nu-latn-ca-gregory', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ---------- الاتصال بالخادم ----------
  function NetErr(m) { var e = new Error(m || 'تعذر الاتصال'); e.net = true; return e; }
  function api(action, payload, timeoutMs) {
    if (!API || API.indexOf('http') !== 0) return Promise.reject(new Error('لم يُضبط رابط الخادم في config.js'));
    var body = Object.assign({ action: action, token: state.token }, payload || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 45000);
    return fetch(API, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctrl && ctrl.signal })
      .catch(function () { throw NetErr(); })
      .then(function (r) { if (!r.ok) throw NetErr('الخادم غير متاح (' + r.status + ')'); return r.json().catch(function () { throw NetErr('رد غير صالح من الخادم'); }); })
      .then(function (j) {
        clearTimeout(timer);
        if (!j.ok) {
          var e = new Error(j.error || 'خطأ'); e.server = true;
          if (/انتهت الجلسة/.test(j.error || '')) { e.auth = true; }
          throw e;
        }
        return j;
      }, function (e) { clearTimeout(timer); throw e; });
  }

  // ---------- صندوق الإرسال (يحفظ الإدخالات عند انقطاع الاتصال) ----------
  function outbox() { return get('outbox', []); }
  function saveOutbox(list) { set('outbox', list); renderNetbar(); }
  function queue(entry) { var l = outbox(); l.push(entry); saveOutbox(l); }
  function dequeue(id) { saveOutbox(outbox().filter(function (x) { return x.clientId !== id; })); }
  function markOutbox(id, patch) { saveOutbox(outbox().map(function (x) { return x.clientId === id ? Object.assign(x, patch) : x; })); }

  var flushing = false;
  function flushOutbox() {
    if (flushing || !state.token) return Promise.resolve();
    var pending = outbox().filter(function (x) { return x.status !== 'error'; });
    if (!pending.length) return Promise.resolve();
    flushing = true;
    var sent = 0;
    return pending.reduce(function (p, e) {
      return p.then(function () {
        return api('submit', { formKey: e.formKey, answers: e.answers, visitedPages: e.visitedPages, clientId: e.clientId })
          .then(function () { dequeue(e.clientId); sent++; })
          .catch(function (err) {
            if (err.auth) throw err;
            if (err.server) markOutbox(e.clientId, { status: 'error', error: err.message });
            else throw err; // انقطاع: نتوقف ونعيد لاحقاً
          });
      });
    }, Promise.resolve()).then(function () {
      if (sent) toast('✓ تم إرسال ' + sent + ' إدخال محفوظ');
    }).catch(function (err) { if (err && err.auth) logout(true); })
      .then(function () { flushing = false; renderNetbar(); });
  }

  function renderNetbar() {
    var bar = document.getElementById('netbar');
    var l = outbox(), off = !navigator.onLine;
    if (!l.length && !off) { bar.classList.add('hidden'); return; }
    var errs = l.filter(function (x) { return x.status === 'error'; }).length;
    var msg = off ? '⚠ لا يوجد اتصال بالإنترنت' : '';
    if (l.length) msg += (msg ? ' — ' : '') + '📤 ' + (l.length - errs) + ' بانتظار الإرسال' + (errs ? ' • ' + errs + ' يحتاج مراجعة' : '') + ' (اضغط للتفاصيل)';
    bar.textContent = msg; bar.classList.remove('hidden');
  }
  document.getElementById('netbar').onclick = function () { location.hash = '#/outbox'; };
  window.addEventListener('online', function () { renderNetbar(); flushOutbox(); });
  window.addEventListener('offline', renderNetbar);
  setInterval(function () { if (navigator.onLine && outbox().length) flushOutbox(); }, 60000);

  // ---------- الدخول ----------
  function logout(expired) {
    state.token = ''; state.user = null; state.menu = null;
    del('token'); del('user'); del('menu'); del('home');
    Object.keys(LS).forEach(function (k) { if (/^amjad_(form_|view_)/.test(k)) LS.removeItem(k); });
    if (expired) toast('انتهت الجلسة، سجّل الدخول من جديد');
    location.hash = '#/login'; route();
  }

  function viewLogin(step, email, msg) {
    if (step === 'code') {
      h('<h1>رمز الدخول</h1><div class="card"><p>أرسلنا رمزاً من 6 أرقام إلى <b dir="ltr">' + esc(email) + '</b>. تحقق من البريد (وأيضاً «الرسائل غير المرغوب فيها»).</p>' +
        (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
        '<input id="code" class="code-in" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">' +
        '<div style="height:12px"></div><button id="go" class="btn block">دخول</button>' +
        '<div style="height:8px"></div><button id="back" class="btn ghost block">تغيير البريد / إعادة إرسال الرمز</button></div>');
      var c = document.getElementById('code'); c.focus();
      var go = document.getElementById('go');
      var submit = function () {
        if (go.disabled) return;
        go.disabled = true; go.textContent = 'جارٍ التحقق…';
        api('verifyCode', { email: email, code: c.value.trim() }).then(function (j) {
          state.token = j.token; state.user = j.user; state.menu = j.menu;
          set('token', j.token); set('user', j.user); set('menu', j.menu);
          location.hash = '#/home'; route(); flushOutbox();
        }).catch(function (e) { viewLogin('code', email, e.message); });
      };
      go.onclick = submit;
      c.oninput = function () { c.value = c.value.replace(/\D/g, ''); if (c.value.length === 6) submit(); };
      document.getElementById('back').onclick = function () { viewLogin('email', email); };
      return;
    }
    h('<h1>تسجيل الدخول</h1><div class="card"><p>اكتب بريدك الإلكتروني المسجّل لدى المدرسة، وسيصلك رمز دخول. يبقى الجهاز مسجلاً بعد ذلك.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<input id="email" type="email" dir="ltr" autocomplete="email" placeholder="name@gmail.com" value="' + esc(email || get('lastEmail', '')) + '">' +
      '<div style="height:12px"></div><button id="send" class="btn block">إرسال رمز الدخول</button></div>');
    var e = document.getElementById('email'), b = document.getElementById('send');
    var go = function () {
      if (b.disabled) return;
      var v = e.value.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(v)) { viewLogin('email', v, 'اكتب بريداً صحيحاً'); return; }
      b.disabled = true; b.textContent = 'جارٍ الإرسال…'; set('lastEmail', v);
      api('requestCode', { email: v }).then(function () { viewLogin('code', v); })
        .catch(function (err) { viewLogin('email', v, err.net ? 'تعذر الاتصال، تحقق من الإنترنت' : err.message); });
    };
    b.onclick = go; e.onkeydown = function (ev) { if (ev.key === 'Enter') go(); };
  }

  // ---------- الرئيسية ----------
  function viewHome() {
    var u = state.user || {}, m = state.menu || { forms: [], views: [] };
    var html = '<div class="card userline"><div><b>' + esc(u.name || u.email) + '</b><div class="muted" dir="ltr" style="text-align:right">' + esc(u.email) + '</div></div>' +
      '<div><span class="role">' + esc(u.roleLabel || '') + '</span> <button id="out" class="btn small ghost">خروج</button></div></div>';
    html += '<div id="alerts"></div><div id="kpis"></div>';
    if (m.forms.length) {
      html += '<h2>الإدخال</h2><div class="grid">' + m.forms.map(function (f) {
        return '<a class="tile form" href="#/form/' + f.key + '">' + esc(f.title) + '<small>' + formHint(f.key) + '</small></a>';
      }).join('') + '</div>';
    }
    var groups = {};
    m.views.forEach(function (v) { (groups[v.group] = groups[v.group] || []).push(v); });
    Object.keys(groups).forEach(function (g) {
      html += '<h2>' + esc(g) + '</h2><div class="grid">' + groups[g].map(function (v) {
        return '<a class="tile" id="t_' + v.key + '" href="#/view/' + v.key + '">' + esc(v.title) + '<small>عرض فقط</small></a>';
      }).join('') + '</div>';
    });
    if (outbox().length) html += '<h2>بانتظار الإرسال</h2><a class="tile" href="#/outbox">📤 ' + outbox().length + ' إدخال محفوظ في الجهاز</a>';
    h(html);
    document.getElementById('out').onclick = function () { if (confirm('تسجيل الخروج من هذا الجهاز؟')) logout(); };
    var cached = get('home', null); if (cached) renderKpis(cached);
    refreshHome();
  }
  var homeSeq = 0;
  function refreshHome() {
    var m = state.menu || { views: [] };
    if (!m.views.length || !state.token) return;
    var seq = ++homeSeq;
    api('home').then(function (j) { if (seq !== homeSeq) return; set('home', j.home); renderKpis(j.home); }).catch(function (e) { if (e.auth) logout(true); });
  }
  // تحديث الإشعارات عند الرجوع للتطبيق وكل دقيقتين أثناء فتح الرئيسية
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && /^#\/(home)?$/.test(location.hash || '#/home')) refreshHome();
  });
  setInterval(function () {
    if (document.visibilityState === 'visible' && /^#\/(home)?$/.test(location.hash || '#/home')) refreshHome();
  }, 120000);
  function renderBadges(home) {
    var b = (home && home.badges) || {}, total = 0, items = [];
    Array.prototype.forEach.call(document.querySelectorAll('.tile .badge'), function (x) { x.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll('.tile.alert'), function (x) { x.classList.remove('alert'); var sm = x.querySelector('small'); if (sm) sm.textContent = 'عرض فقط'; });
    Object.keys(b).forEach(function (k) {
      var n = Number(b[k].n) || 0; total += n;
      var t = document.getElementById('t_' + k); if (!t) return;
      var old = t.querySelector('.badge'); if (old) old.remove();
      t.classList.toggle('alert', n > 0);
      var sm = t.querySelector('small');
      if (n > 0) {
        t.insertAdjacentHTML('afterbegin', '<span class="badge" aria-label="' + n + ' ' + esc(b[k].label) + '">' + (n > 99 ? '99+' : n) + '</span>');
        if (sm) sm.textContent = n + ' ' + b[k].label;
        items.push('<a href="#/view/' + k + '"><span class="badge in">' + n + '</span> ' + esc(b[k].label) + '</a>');
      } else if (sm) sm.textContent = 'لا يوجد ما يحتاج متابعة ✓';
    });
    var box = document.getElementById('alerts');
    if (box) box.innerHTML = total ? '<div class="card alerts"><b>🔔 يحتاج متابعتك (' + total + ')</b>' + items.join('') + '</div>' : '';
    try { if (navigator.setAppBadge) { total ? navigator.setAppBadge(total) : navigator.clearAppBadge(); } } catch (e) {}
    try { document.title = (total ? '(' + total + ') ' : '') + document.title.replace(/^\(\d+\) /, ''); } catch (e) {}
  }
  function formHint(k) { return { absence: 'الغائبون والمتأخرون والمستأذنون', behavior: 'مشكلة سلوكية أو سلوك متميز', violation: 'مساءلة إدارية' }[k] || ''; }
  function renderKpis(home) {
    renderBadges(home);
    var el = document.getElementById('kpis'); if (!el || !home) return;
    el.innerHTML = (home.cards || []).map(function (c) {
      return '<div class="card"><b>' + esc(c.title) + '</b><div class="kpis" style="margin-top:8px">' + c.items.map(function (i) {
        return '<div class="kpi"><b>' + esc(i.v) + '</b><span>' + esc(i.k) + '</span></div>';
      }).join('') + '</div></div>';
    }).join('');
  }

  // ---------- مشغّل النماذج (يتبع صفحات وتفرعات نموذج Google نفسه) ----------
  var F = null; // { def, page, history, answers, filters }

  function viewForm(key) {
    h('<button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button><div class="loading">جارٍ تحميل النموذج…</div>');
    var cached = get('form_' + key, null);
    var start = function (def, offline) {
      var draft = get('draft_' + key, null);
      F = { key: key, def: def, page: 0, history: [], answers: {}, filters: {}, offline: offline };
      if (draft && draft.answers && confirm('لديك إدخال غير مكتمل لهذا النموذج. هل تريد إكماله؟')) { F.answers = draft.answers; F.page = draft.page || 0; F.history = draft.history || []; }
      else del('draft_' + key);
      Object.keys(def.locked || {}).forEach(function (id) { F.answers[id] = def.locked[id]; });
      renderPage();
    };
    api('getForm', { formKey: key }).then(function (j) { set('form_' + key, j.form); start(j.form, false); })
      .catch(function (e) {
        if (e.auth) return logout(true);
        if (cached && e.net) { toast('بدون اتصال: تم فتح آخر نسخة محفوظة من النموذج'); start(cached, true); }
        else h('<button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button><div class="err">' + esc(e.message) + '</div><button class="btn" onclick="location.reload()">إعادة المحاولة</button>');
      });
  }

  function saveDraft() { set('draft_' + F.key, { answers: F.answers, page: F.page, history: F.history }); }

  function isEmpty(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length); }

  function nextTarget() {
    var page = F.def.pages[F.page], nav = null;
    page.items.forEach(function (it) {
      if (!it.choices || it.type === 'checkbox') return;
      var a = F.answers[it.id];
      var c = it.choices.filter(function (x) { return x.v === a; })[0];
      if (c && c.nav) nav = c.nav;
    });
    nav = nav || page.next || { type: 'CONTINUE' };
    if (nav.type === 'SUBMIT') return -1;
    if (nav.type === 'RESTART') return 0;
    if (nav.type === 'GO_TO_PAGE' && typeof nav.page === 'number') return nav.page;
    return F.page + 1 < F.def.pages.length ? F.page + 1 : -1;
  }

  function renderPage(errMsg) {
    var def = F.def, page = def.pages[F.page];
    var html = '<button class="back" id="home">→ الرئيسية</button><h1>' + esc(def.title) + '</h1>';
    if (F.offline) html += '<div class="warnbox" style="margin-bottom:8px">بدون اتصال — سيُحفظ الإدخال في الجهاز ويُرسل تلقائياً عند عودة الإنترنت.</div>';
    html += '<div class="pagehead">' + esc(F.page === 0 ? 'البيانات الأساسية' : page.title || ('الصفحة ' + (F.page + 1))) + '</div><div class="pagebody">';
    if (F.page > 0 && page.help) html += '<p class="help">' + esc(page.help) + '</p>';
    page.items.forEach(function (it) { html += renderItem(it); });
    html += '</div>';
    if (errMsg) html += '<div class="err">' + esc(errMsg) + '</div>';
    var nt = nextTarget();
    html += '<div class="actions">' + (F.history.length ? '<button class="btn ghost" id="prev">السابق</button>' : '') +
      '<button class="btn ' + (nt < 0 ? 'green' : '') + '" id="next">' + (nt < 0 ? 'إرسال ✓' : 'التالي ←') + '</button></div>';
    h(html);
    bindItems(page);
    document.getElementById('home').onclick = function () { location.hash = '#/home'; };
    var prev = document.getElementById('prev');
    if (prev) prev.onclick = function () { F.page = F.history.pop(); saveDraft(); renderPage(); };
    document.getElementById('next').onclick = onNext;
  }

  function renderItem(it) {
    if (it.type === 'header') return '<div class="item"><b>' + esc(it.title) + '</b>' + (it.help ? '<div class="help">' + esc(it.help) + '</div>' : '') + '</div>';
    var a = F.answers[it.id], locked = F.def.locked && F.def.locked[it.id] !== undefined;
    var head = '<label class="q">' + esc(it.title) + (it.required ? ' <span class="req">*</span>' : '') + '</label>' + (it.help ? '<div class="help">' + esc(it.help) + '</div>' : '');
    var body = '';
    if (locked) {
      var lv = String(F.def.locked[it.id]);
      body = lv.indexOf('__MISSING__') === 0 ? '<div class="err">اسمك غير موجود في قائمة هذا النموذج. راجع الوكيل.</div>' : '<div class="locked">' + esc(lv) + '</div>';
    } else if (it.type === 'list' || (it.type === 'choice' && it.choices.length > 8)) {
      body = '<select data-id="' + it.id + '"><option value="">— اختر —</option>' + it.choices.map(function (c) {
        return '<option' + (a === c.v ? ' selected' : '') + '>' + esc(c.v) + '</option>';
      }).join('') + '</select>';
    } else if (it.type === 'choice') {
      body = '<div class="pills">' + it.choices.map(function (c, i) {
        return '<button type="button" class="pill' + (a === c.v ? ' on' : '') + '" data-id="' + it.id + '" data-i="' + i + '">' + esc(c.v) + '</button>';
      }).join('') + '</div>';
    } else if (it.type === 'checkbox') {
      var sel = Array.isArray(a) ? a : [];
      var filt = it.choices.length > 12 ? '<input type="search" placeholder="🔎 ابحث بالاسم…" data-filter="' + it.id + '" value="' + esc(F.filters[it.id] || '') + '" style="margin-bottom:6px">' : '';
      body = filt + '<div class="checks" data-checks="' + it.id + '">' + it.choices.map(function (c, i) {
        var on = sel.indexOf(c.v) >= 0;
        return '<div class="check' + (on ? ' on' : '') + '" data-id="' + it.id + '" data-i="' + i + '" role="checkbox" aria-checked="' + on + '" tabindex="0"><span class="box">' + (on ? '✓' : '') + '</span><span class="lbl">' + esc(c.v) + '</span></div>';
      }).join('') + '</div><div class="selcount" id="cnt_' + it.id + '">' + (sel.length ? 'تم اختيار ' + sel.length : '') + '</div>';
    } else if (it.type === 'paragraph') {
      body = '<textarea data-id="' + it.id + '">' + esc(a || '') + '</textarea>';
    } else if (it.type === 'date') {
      if (isEmpty(a)) { a = todayISO(); F.answers[it.id] = a; }
      body = '<input type="date" data-id="' + it.id + '" value="' + esc(a) + '">';
    } else if (it.type === 'time') {
      body = '<input type="time" data-id="' + it.id + '" value="' + esc(a || '') + '">';
    } else if (it.type === 'scale') {
      var opts = []; for (var s = it.min; s <= it.max; s++) opts.push(s);
      body = '<div class="pills">' + opts.map(function (s) { return '<button type="button" class="pill' + (String(a) === String(s) ? ' on' : '') + '" data-scale="' + it.id + '" data-v="' + s + '">' + s + '</button>'; }).join('') + '</div>';
    } else if (it.type === 'text') {
      body = '<input type="text" data-id="' + it.id + '" value="' + esc(a || '') + '">';
    } else {
      return '';
    }
    return '<div class="item">' + head + body + '</div>';
  }

  function bindItems(page) {
    var byId = {}; page.items.forEach(function (it) { byId[it.id] = it; });
    var refreshNext = function () {
      var b = document.getElementById('next'); if (!b) return;
      var nt = nextTarget(); b.textContent = nt < 0 ? 'إرسال ✓' : 'التالي ←'; b.className = 'btn ' + (nt < 0 ? 'green' : '');
    };
    $app.querySelectorAll('select[data-id],input[data-id],textarea[data-id]').forEach(function (el) {
      var ev = el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time' ? 'change' : 'input';
      el.addEventListener(ev, function () { F.answers[el.dataset.id] = el.value; saveDraft(); refreshNext(); });
    });
    $app.querySelectorAll('.pill[data-i]').forEach(function (el) {
      el.onclick = function () {
        var it = byId[el.dataset.id], v = it.choices[+el.dataset.i].v;
        F.answers[it.id] = F.answers[it.id] === v ? '' : v; saveDraft();
        el.parentNode.querySelectorAll('.pill').forEach(function (p) { p.classList.toggle('on', p === el && F.answers[it.id] === v); });
        refreshNext();
      };
    });
    $app.querySelectorAll('.pill[data-scale]').forEach(function (el) {
      el.onclick = function () { F.answers[el.dataset.scale] = el.dataset.v; saveDraft(); el.parentNode.querySelectorAll('.pill').forEach(function (p) { p.classList.toggle('on', p === el); }); };
    });
    $app.querySelectorAll('.check').forEach(function (el) {
      var toggle = function () {
        var it = byId[el.dataset.id], v = it.choices[+el.dataset.i].v;
        var sel = Array.isArray(F.answers[it.id]) ? F.answers[it.id].slice() : [];
        var k = sel.indexOf(v); if (k >= 0) sel.splice(k, 1); else sel.push(v);
        // يحفظ ترتيب الخيارات كما في النموذج
        F.answers[it.id] = it.choices.map(function (c) { return c.v; }).filter(function (x) { return sel.indexOf(x) >= 0; });
        var on = k < 0; el.classList.toggle('on', on); el.setAttribute('aria-checked', on); el.querySelector('.box').textContent = on ? '✓' : '';
        document.getElementById('cnt_' + it.id).textContent = F.answers[it.id].length ? 'تم اختيار ' + F.answers[it.id].length : '';
        saveDraft();
      };
      el.onclick = toggle;
      el.onkeydown = function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
    });
    $app.querySelectorAll('input[data-filter]').forEach(function (inp) {
      var apply = function () {
        var q = inp.value.trim(); F.filters[inp.dataset.filter] = q;
        $app.querySelectorAll('[data-checks="' + inp.dataset.filter + '"] .check').forEach(function (c) {
          c.style.display = !q || c.textContent.indexOf(q) >= 0 ? '' : 'none';
        });
      };
      inp.oninput = apply; apply();
    });
  }

  function validatePage() {
    var page = F.def.pages[F.page];
    for (var i = 0; i < page.items.length; i++) {
      var it = page.items[i];
      if (it.required && isEmpty(F.answers[it.id])) return 'الحقل «' + it.title + '» مطلوب';
      if (String(F.answers[it.id] || '').indexOf('__MISSING__') === 0) return 'اسمك غير موجود في قائمة النموذج. راجع الوكيل.';
    }
    return '';
  }

  function onNext() {
    if (state.sending) return;
    var err = validatePage(); if (err) return renderPage(err);
    var nt = nextTarget();
    if (nt >= 0) { F.history.push(F.page); F.page = nt; saveDraft(); return renderPage(); }
    doSubmit();
  }

  function collect() {
    var visited = F.history.concat([F.page]).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    var answers = {};
    visited.forEach(function (pi) { F.def.pages[pi].items.forEach(function (it) { if (!isEmpty(F.answers[it.id])) answers[it.id] = F.answers[it.id]; }); });
    return { visitedPages: visited, answers: answers };
  }

  function doSubmit() {
    var btn = document.getElementById('next');
    state.sending = true; btn.disabled = true; btn.textContent = 'جارٍ الحفظ…';
    var prev = document.getElementById('prev'); if (prev) prev.disabled = true;
    var c = collect();
    var entry = { clientId: uuid(), formKey: F.key, title: F.def.title, answers: c.answers, visitedPages: c.visitedPages, createdAt: new Date().toISOString(), status: 'sending', summary: summary(c.answers) };
    queue(entry);               // يُحفظ في الجهاز قبل الإرسال؛ لا يضيع حتى لو أُغلق التطبيق
    del('draft_' + F.key);
    api('submit', { formKey: entry.formKey, answers: entry.answers, visitedPages: entry.visitedPages, clientId: entry.clientId }, 60000)
      .then(function (j) {
        dequeue(entry.clientId); state.sending = false;
        viewDone(true, j.savedAt);
      })
      .catch(function (e) {
        state.sending = false;
        if (e.auth) { markOutbox(entry.clientId, { status: 'pending' }); return logout(true); }
        if (e.server) {
          dequeue(entry.clientId); set('draft_' + F.key, { answers: F.answers, page: F.page, history: F.history });
          return renderPage(e.message);
        }
        markOutbox(entry.clientId, { status: 'pending' });
        viewDone(false);
      });
  }

  function summary(ans) {
    var parts = [];
    Object.keys(ans).forEach(function (k) { var v = ans[k]; if (Array.isArray(v)) parts.push(v.length + ' طالب'); });
    return parts.join('، ');
  }

  function viewDone(ok, savedAt) {
    var key = F.key;
    if (ok) {
      h('<div class="okbox"><div class="big">✓</div><h1 style="color:var(--ok)">تم الحفظ بنجاح</h1><p>تم تسجيل الإدخال في ملف المدرسة.<br><b>' + esc(fmtTime(savedAt)) + '</b></p></div>' +
        '<div class="actions"><a class="btn" href="#/form/' + key + '" id="again">إدخال جديد</a><a class="btn ghost" href="#/home">الرئيسية</a></div>');
      document.getElementById('again').onclick = function (e) { e.preventDefault(); viewForm(key); };
    } else {
      h('<div class="warnbox"><div style="font-size:40px">📤</div><h1 style="color:#8a5300">لم يصل بعد</h1><p>تعذر الاتصال بالخادم. <b>الإدخال محفوظ في هذا الجهاز</b> وسيُرسل تلقائياً عند عودة الإنترنت، أو اضغط «إعادة المحاولة».</p></div>' +
        '<div class="actions"><button class="btn" id="retry">إعادة المحاولة</button><a class="btn ghost" href="#/home">الرئيسية</a></div>');
      document.getElementById('retry').onclick = function () {
        this.disabled = true; this.textContent = 'جارٍ الإرسال…';
        flushOutbox().then(function () { if (!outbox().length) toast('✓ تم الإرسال والحفظ'); location.hash = '#/outbox'; route(); });
      };
    }
  }

  // ---------- صندوق الإرسال ----------
  function viewOutbox() {
    var l = outbox();
    var html = '<button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button><h1>بانتظار الإرسال</h1>';
    if (!l.length) html += '<div class="okbox">✓ لا توجد إدخالات معلّقة — كل شيء وصل.</div>';
    else {
      html += '<div class="card">' + l.map(function (e) {
        return '<div class="outbox-item"><div><b>' + esc(e.title) + '</b><div class="muted">' + esc(fmtTime(e.createdAt)) + (e.summary ? ' • ' + esc(e.summary) : '') + '</div>' +
          (e.status === 'error' ? '<div class="err" style="margin:4px 0">' + esc(e.error) + '</div>' : '') + '</div>' +
          (e.status === 'error' ? '<button class="btn small ghost" data-del="' + e.clientId + '">حذف</button>' : '<span class="muted">معلّق</span>') + '</div>';
      }).join('') + '</div><button class="btn block" id="send">إرسال الآن</button>';
    }
    h(html);
    var s = document.getElementById('send');
    if (s) s.onclick = function () { s.disabled = true; s.textContent = 'جارٍ الإرسال…'; flushOutbox().then(viewOutbox); };
    $app.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { if (confirm('حذف هذا الإدخال نهائياً؟')) { dequeue(b.dataset.del); viewOutbox(); } }; });
  }

  // ---------- لوحات المتابعة (عرض فقط) ----------
  function viewSheet(key) {
    var meta = (state.menu.views || []).filter(function (v) { return v.key === key; })[0];
    if (!meta) { location.hash = '#/home'; return; }
    var back = '<button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button>';
    var V = null;
    function txt(c) { return c && typeof c === 'object' ? (c.t || '') : String(c == null ? '' : c); }
    function tone(t) {
      if (/^(✅|✓|✔|🏁)|مغلق|تم /.test(t)) return 'ok';
      if (/^(⏳|🔁|📞|👤|👥|🗣)|بانتظار|مفتوح|قيد|متابعة/.test(t)) return 'warn';
      if (/^(❌|⚠|🔴|⛔)|إنذار|فصل/.test(t)) return 'bad';
      return '';
    }
    function cellHtml(c, head) {
      if (c && typeof c === 'object') return '<a class="linkbtn" href="' + esc(c.l) + '" target="_blank" rel="noopener">' + esc(c.t || 'فتح') + '</a>';
      var t = String(c == null ? '' : c);
      if (t && /الحالة|تنبيه|القرار|قرار/.test(head) && t.length < 60) { var k = tone(t); if (k || /^\W/.test(t)) return '<span class="chip ' + k + '">' + esc(t) + '</span>'; }
      return esc(t);
    }
    function kpiTiles(sec) {
      return '<div class="kpis big">' + sec.header.map(function (h, i) {
        return '<div class="kpi"><b>' + cellHtml(sec.rows[0].cells[i], '') + '</b><span>' + esc(h.t) + '</span></div>';
      }).join('') + '</div>';
    }
    function tableHtml(sec, si) {
      var heads = sec.header.map(function (h) { return txt(h.t); });
      var html = '<div class="tcount">' + sec.rows.length + ' سجل</div><div class="tablewrap pro"><table class="sheet pro"><thead><tr>' + (sec.edit ? '<th>إجراء</th>' : '') +
        heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
      if (!sec.rows.length) html += '<tr><td colspan="' + (heads.length + 1) + '" class="emptyrow">لا توجد سجلات حالياً ✓</td></tr>';
      sec.rows.forEach(function (r, ri) {
        html += '<tr class="data">' + (sec.edit ? '<td class="act"><button class="btn small" data-edit="' + si + ':' + ri + '">✏️ قرار / تعديل</button></td>' : '') + r.cells.map(function (c, ci) {
          var t = txt(c);
          return '<td data-label="' + esc(heads[ci]) + '"' + (t === '' ? ' class="empty"' : '') + '>' + cellHtml(c, heads[ci]) + '</td>';
        }).join('') + '</tr>';
      });
      return html + '</tbody></table></div>';
    }
    function draw(v) {
      V = v;
      var texts = [], body = '';
      v.sections.forEach(function (sec, si) {
        if (sec.type === 'text') { if (body) body += '<h2 class="sub">' + esc(sec.text) + '</h2>'; else texts.push(sec.text); return; }
        if (!sec.rows.length && sec.header.length <= 4) { body += '<div class="infoline">' + sec.header.map(function (h) { return esc(h.t); }).join(' ') + '</div>'; return; }
        if (sec.rows.length === 1 && !sec.edit && sec.header.length <= 12) { body += kpiTiles(sec); return; }
        body += tableHtml(sec, si);
      });
      if (v.date) {
        texts = texts.filter(function (t) { return !/التاريخ/.test(t); });
        body = body.replace(/<div class="infoline">[^<]*التاريخ[^<]*<\/div>/g, '');
      }
      var lead = texts.shift();
      var html = back + '<div class="vhead"><div><h1>' + esc(v.title) + '</h1>' + (lead ? '<div class="lead">' + esc(lead) + '</div>' : '') + '</div>' +
        '<div class="vtools"><button class="btn small ghost" id="ref">↻ تحديث</button>' +
        (meta.url ? '<a class="btn small ghost" target="_blank" rel="noopener" href="' + esc(meta.url) + '">فتح الملف</a>' : '') + '</div></div>' +
        (texts.length ? '<details class="hint"><summary>ℹ️ طريقة الاستخدام</summary>' + texts.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') + '</details>' : '') +
        (v.date ? dateBar(v.date) : '') +
        '<div class="toolbar"><input type="search" id="q" placeholder="🔎 ابحث في هذه اللوحة باسم طالب أو معلم…"></div><div id="nores" class="warnbox hidden">لا توجد نتائج لهذا البحث في هذه اللوحة</div>' +
        '<div class="muted small">آخر تحديث: ' + esc(fmtTime(v.updatedAt)) + '</div>' + body;
      h(html);
      var q = document.getElementById('q');
      q.oninput = function () {
        var s = q.value.trim();
        var shown = 0, all = $app.querySelectorAll('tr.data');
        all.forEach(function (tr) { var on = !s || tr.textContent.indexOf(s) >= 0; tr.style.display = on ? '' : 'none'; if (on) shown++; });
        document.getElementById('nores').classList.toggle('hidden', !s || shown > 0 || !all.length);
      };
      document.getElementById('ref').onclick = load;
      var ds = document.getElementById('dsel');
      if (ds) ds.onchange = function () {
        ds.disabled = true; toast('جارٍ تغيير التاريخ…');
        api('setDate', { viewKey: key, date: ds.value }, 60000).then(function () { load(); })
          .catch(function (e) { ds.disabled = false; if (e.auth) return logout(true); toast(e.net ? 'تعذر الاتصال' : e.message); });
      };
      $app.querySelectorAll('[data-edit]').forEach(function (b) {
        b.onclick = function () { var p = b.dataset.edit.split(':'); openEditor(v.sections[+p[0]], v.sections[+p[0]].rows[+p[1]]); };
      });
    }
    function dateBar(d) {
      var days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      var iso = function (x) { return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); };
      var lab = function (s) { var p = s.split('-'), x = new Date(+p[0], +p[1] - 1, +p[2]); return days[x.getDay()] + '  ' + p[0] + '/' + p[1] + '/' + p[2]; };
      var opts = [], seen = {}, t = new Date();
      for (var k = 0; opts.length < 30 && k < 60; k++) {
        var x = new Date(t.getFullYear(), t.getMonth(), t.getDate() - k);
        if (x.getDay() === 5 || x.getDay() === 6) continue;
        var s = iso(x); seen[s] = 1; opts.push(s);
      }
      if (d.value && !seen[d.value]) opts.unshift(d.value);
      return '<div class="datebar"><label for="dsel">📅 تاريخ التقرير</label><select id="dsel"><option value="today"' + (d.auto ? ' selected' : '') + '>آخر يوم دراسي (تلقائي)</option>' +
        opts.map(function (s) { return '<option value="' + s + '"' + (!d.auto && s === d.value ? ' selected' : '') + '>' + lab(s) + '</option>'; }).join('') + '</select></div>';
    }
    function toISO(t) { var m = String(t).match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/); return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : ''; }
    function openEditor(sec, row) {
      var heads = sec.header.map(function (h) { return txt(h.t); });
      var editIdx = sec.edit.map(function (e) { return e.i; });
      var info = heads.map(function (h, i) {
        var t = txt(row.cells[i]); if (!t || editIdx.indexOf(i) >= 0 || typeof row.cells[i] === 'object') return '';
        return '<div class="kv"><span>' + esc(h) + '</span><b>' + esc(t) + '</b></div>';
      }).join('');
      var fields = sec.edit.map(function (e, n) {
        var cur = txt(row.cells[e.i]), id = 'ef' + n, f;
        if (e.type === 'list') {
          f = '<select id="' + id + '"><option value="">— اختر —</option>' + (e.options || []).map(function (o) { return '<option' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') +
            (cur && (e.options || []).indexOf(cur) < 0 ? '<option selected>' + esc(cur) + '</option>' : '') + '</select>';
        } else if (e.type === 'date') {
          f = '<input type="date" id="' + id + '" value="' + esc(toISO(cur)) + '">';
        } else {
          f = '<textarea id="' + id + '" rows="3">' + esc(cur) + '</textarea>';
        }
        return '<div class="item"><label class="q">' + esc(e.name.replace(/[▼③]/g, '').trim()) + (e.trigger ? ' <span class="chip warn">قرار</span>' : '') + '</label>' + f + '</div>';
      }).join('');
      var ov = document.createElement('div'); ov.className = 'overlay';
      ov.innerHTML = '<div class="sheetbox" role="dialog" aria-modal="true"><div class="sheethead"><b>اتخاذ قرار / تعديل</b><button class="x" id="ecl" aria-label="إغلاق">✕</button></div>' +
        '<div class="sheetbody"><div class="kvs">' + info + '</div>' + fields +
        '<div class="muted small">يُحفظ مباشرة في الملف، ويُنفَّذ القرار تلقائياً كما لو اخترته من الشيت.</div><div id="eerr"></div></div>' +
        '<div class="actions"><button class="btn ghost" id="ecn">إلغاء</button><button class="btn green" id="esv">حفظ ✓</button></div></div>';
      document.body.appendChild(ov);
      var close = function () { ov.remove(); };
      ov.onclick = function (e) { if (e.target === ov) close(); };
      document.getElementById('ecl').onclick = close; document.getElementById('ecn').onclick = close;
      var sv = document.getElementById('esv');
      sv.onclick = function () {
        var values = {}, n = 0;
        sec.edit.forEach(function (e, k) {
          var el = document.getElementById('ef' + k), val = el.value.trim(), cur = txt(row.cells[e.i]);
          var same = e.type === 'date' ? val === toISO(cur) : val === cur;
          if (!same) { values[e.name] = val; n++; }
        });
        if (!n) { close(); return; }
        sv.disabled = true; sv.textContent = 'جارٍ الحفظ…';
        api('edit', { viewKey: key, row: row.r, key: row.key, values: values }, 60000).then(function () {
          close(); toast('✓ تم الحفظ في الملف'); load();
        }).catch(function (e) {
          if (e.auth) { close(); return logout(true); }
          sv.disabled = false; sv.textContent = 'حفظ ✓';
          document.getElementById('eerr').innerHTML = '<div class="err">' + esc(e.net ? 'تعذر الاتصال، حاول مرة أخرى' : e.message) + '</div>';
        });
      };
    }
    function load() {
      if (!V) h(back + '<div class="loading">جارٍ تحميل «' + esc(meta.title) + '»…</div>');
      api('view', { viewKey: key }).then(function (j) { draw(j.view); })
        .catch(function (e) {
          if (e.auth) return logout(true);
          h(back + '<div class="err">' + esc(e.net ? 'تعذر الاتصال بالإنترنت' : e.message) + '</div><button class="btn" id="r">إعادة المحاولة</button>');
          document.getElementById('r').onclick = load;
        });
    }
    load();
  }

  // ---------- التوجيه ----------
  function route() {
    renderNetbar();
    document.body.classList.toggle('wide', /^#\/view\//.test(location.hash || ''));
    var hash = location.hash || '#/home';
    if (!state.token) { return viewLogin('email'); }
    var m = hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
    if (m[1] === 'form' && m[2]) {
      if (!(state.menu.forms || []).some(function (f) { return f.key === m[2]; })) { location.hash = '#/home'; return; }
      return viewForm(m[2]);
    }
    if (m[1] === 'view' && m[2]) return viewSheet(m[2]);
    if (m[1] === 'outbox') return viewOutbox();
    return viewHome();
  }
  window.addEventListener('hashchange', function () { if (!state.sending) route(); });
  document.getElementById('brand').onclick = function () { location.hash = '#/home'; };

  // تحديث الصلاحيات والقائمة عند كل فتح (لو أُضيف معلم أو حُذف)
  function refreshMe() {
    if (!state.token || !navigator.onLine) return;
    api('me').then(function (j) {
      state.user = j.user; state.menu = j.menu; set('user', j.user); set('menu', j.menu);
      if (/^#\/(home)?$/.test(location.hash || '#/home') || !location.hash) viewHome();
    }).catch(function (e) { if (e.auth) logout(true); });
  }

  // ---------- التثبيت ----------
  var deferred = null, ib = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; ib.classList.remove('hidden'); });
  ib.onclick = function () { if (!deferred) return; deferred.prompt(); deferred.userChoice.then(function () { deferred = null; ib.classList.add('hidden'); }); };
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });

  route(); refreshMe(); flushOutbox();
  window.__amjad = { state: state, outbox: outbox, flushOutbox: flushOutbox }; // للاختبار
})();
