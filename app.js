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

  // ---------- تقارير الأداء: أسبوعي / شهري ----------
  function viewReport() {
    var MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    var iso = function (x) { return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); };
    var add = function (x, n) { return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n); };
    var fmt = function (s) { var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; };
    var t0 = new Date(); t0 = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate());
    var sun = add(t0, -t0.getDay()); // الأسبوع الدراسي: الأحد – الخميس
    function range(kind) {
      if (kind === 'week') return { title: 'التقرير الأسبوعي', sub: 'الأسبوع الحالي', from: iso(sun), to: iso(add(sun, 4)), pfrom: iso(add(sun, -7)), pto: iso(add(sun, -3)), pname: 'الأسبوع السابق' };
      if (kind === 'pweek') return { title: 'التقرير الأسبوعي', sub: 'الأسبوع الماضي', from: iso(add(sun, -7)), to: iso(add(sun, -3)), pfrom: iso(add(sun, -14)), pto: iso(add(sun, -10)), pname: 'الأسبوع الذي قبله' };
      var y = t0.getFullYear(), mo = t0.getMonth() - (kind === 'pmonth' ? 1 : 0);
      var a = new Date(y, mo, 1), b = new Date(y, mo + 1, 0), pa = new Date(y, mo - 1, 1), pb = new Date(y, mo, 0);
      return { title: 'التقرير الشهري', sub: 'شهر ' + MONTHS[a.getMonth()] + ' ' + a.getFullYear(), from: iso(a), to: iso(b), pfrom: iso(pa), pto: iso(pb), pname: 'شهر ' + MONTHS[pa.getMonth()] };
    }
    function custom(f, t) {
      var a = new Date(f), b = new Date(t), n = Math.round((b - a) / 864e5) + 1;
      return { title: 'تقرير أداء الفترة', sub: 'من ' + fmt(f) + ' إلى ' + fmt(t), from: f, to: t, pfrom: iso(add(new Date(a.getFullYear(), a.getMonth(), a.getDate()), -n)), pto: iso(add(new Date(a.getFullYear(), a.getMonth(), a.getDate()), -1)), pname: 'الفترة السابقة بنفس الطول' };
    }
    var kind = get('perfKind', 'week'), R = kind === 'custom' ? null : range(kind);
    var tabs = [['week', 'هذا الأسبوع'], ['pweek', 'الأسبوع الماضي'], ['month', 'هذا الشهر'], ['pmonth', 'الشهر الماضي'], ['custom', 'فترة مخصصة']];
    h('<div class="noprint"><button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button>' +
      '<div class="ptabs">' + tabs.map(function (x) { return '<button class="btn small ' + (x[0] === kind ? '' : 'ghost') + '" data-k="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="pcustom ' + (kind === 'custom' ? '' : 'hidden') + '"><label>من <input type="date" id="pf" value="' + iso(add(t0, -30)) + '"></label><label>إلى <input type="date" id="pt" value="' + iso(t0) + '"></label><button class="btn small" id="pgo">عرض</button></div>' +
      '<div class="vtools"><button class="btn small ghost" id="pprint">🖨️ طباعة / حفظ PDF</button></div></div><div id="pbody"></div>');
    Array.prototype.forEach.call($app.querySelectorAll('.ptabs [data-k]'), function (b) {
      b.onclick = function () { set('perfKind', b.getAttribute('data-k')); viewReport(); };
    });
    document.getElementById('pprint').onclick = function () { window.print(); };
    var go = document.getElementById('pgo');
    if (go) go.onclick = function () {
      var f = document.getElementById('pf').value, t = document.getElementById('pt').value;
      if (!f || !t || f > t) { toast('اختر تاريخ بداية ونهاية صحيحين'); return; }
      load(custom(f, t));
    };
    if (R) load(R); else document.getElementById('pbody').innerHTML = '<div class="infoline">اختر تاريخ البداية والنهاية ثم اضغط «عرض».</div>';

    function load(R) {
      var box = document.getElementById('pbody');
      box.innerHTML = '<div class="loading">جارٍ إعداد التقرير… (قد يستغرق 20 ثانية)</div>';
      api('perf', { from: R.from, to: R.to, pfrom: R.pfrom, pto: R.pto }, 120000).then(function (j) {
        if (!document.getElementById('pbody')) return;
        draw(R, j.cur, j.prev);
      }).catch(function (e) {
        if (e.auth) return logout(true);
        var b = document.getElementById('pbody'); if (b) b.innerHTML = '<div class="err">' + esc(e.net ? 'تعذر الاتصال، حاول مرة أخرى' : e.message) + '</div>';
      });
    }
    function num(v, pct) { return v === null || v === undefined ? '—' : (pct ? v + '%' : String(v)); }
    function delta(c, p, goodUp, pct) {
      if (c === null || p === null || p === undefined || c === undefined) return '';
      var d = Math.round((c - p) * 10) / 10; if (!d) return '<i class="dl eq">= بدون تغيير</i>';
      var good = goodUp ? d > 0 : d < 0;
      return '<i class="dl ' + (good ? 'up' : 'down') + '">' + (d > 0 ? '▲ ' : '▼ ') + Math.abs(d) + (pct ? '%' : '') + '</i>';
    }
    function kpi(label, c, p, goodUp, pct) {
      return '<div class="pk"><span>' + esc(label) + '</span><b dir="ltr">' + num(c, pct) + '</b>' + delta(c, p, goodUp, pct) + '</div>';
    }
    function tbl(head, rows) {
      if (!rows.length) return '<div class="infoline">لا توجد بيانات في هذه الفترة</div>';
      return '<div class="repwrap"><table class="rept"><thead><tr>' + head.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td>' + x + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }
    function name(k) { return esc(String(k).replace(/^\S+\s*-\s*/, '')); }
    function cls(k) { return esc(String(k).split(' - ')[0]); }
    function draw(R, c, p) {
      p = p || {};
      var pb = p.beh || {}, pt = p.teach || {}, pv = p.viol || {};
      var DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      var html = '<div class="rep perf"><div class="rephead"><img src="icons/icon-512.png" alt=""><div><b>مدارس الأمجاد العالمية</b><span>AL-AMJAD INTERNATIONAL SCHOOLS</span><i>Learning for the life</i></div><em class="conf" style="color:#1A9BD7">وكالة شؤون الطلاب<br>قسم البنين</em></div>' +
        '<div class="reptitle">' + esc(R.title) + ' – ' + esc(R.sub) + '</div>' +
        '<div class="repsub">الفترة: من ' + fmt(c.from) + ' إلى ' + fmt(c.to) + '  |  أيام الدراسة المرصودة: ' + c.schoolDays + '  |  عدد الطلاب: ' + c.students + '  |  المقارنة مع: ' + esc(R.pname) + '</div>';
      if (!c.schoolDays) html += '<div class="warnbox">لا يوجد رصد غياب في هذه الفترة بعد.</div>';
      html += '<div class="repbar">أولاً: الملخص العام</div><div class="pks">' +
        kpi('نسبة حضور الطلاب', c.attendance, p.attendance, true, true) +
        kpi('أيام غياب (يوم كامل)', c.absDays, p.absDays, false) +
        kpi('غياب عن حصص (طالب/يوم)', c.partial, p.partial, false) +
        kpi('حالات التأخر', c.lates, p.lates, false) +
        kpi('طلاب غابوا 3 أيام فأكثر', c.chronic, p.chronic, false) +
        kpi('التزام المعلمين بالرصد', c.teach.rate, pt.rate, true, true) +
        kpi('المشكلات السلوكية', c.beh.problems, pb.problems, false) +
        kpi('السلوك المتميز', c.beh.distinct, pb.distinct, true) +
        kpi('مخالفات المعلمين', c.viol.n, pv.n, false) + '</div>';
      html += '<div class="repbar">ثانياً: الحضور حسب الفصل</div>' + tbl(['الفصل', 'الطلاب', 'أيام الغياب', 'غياب عن حصص', 'التأخر', 'نسبة الحضور'],
        c.classes.map(function (x) {
          var pc = (p.classes || []).filter(function (y) { return y.c === x.c; })[0];
          return [esc(x.c), x.n, x.abs, x.partial, x.late, '<b>' + num(x.rate, true) + '</b> ' + delta(x.rate, pc ? pc.rate : null, true, true)];
        }));
      var mx = Math.max.apply(null, c.daily.map(function (x) { return x.abs; }).concat([1]));
      html += '<div class="repbar">ثالثاً: الغياب اليومي</div>' + (c.daily.length ? '<div class="bars">' + c.daily.map(function (x) {
        var pp = x.d.split('-'), wd = DAYS[new Date(+pp[0], +pp[1] - 1, +pp[2]).getDay()];
        return '<div class="bar"><span>' + wd + ' ' + pp[2] + '/' + pp[1] + (x.d === iso(t0) ? ' (حتى الآن)' : '') + '</span><div><i style="width:' + Math.round(100 * x.abs / mx) + '%"></i></div><b>' + x.abs + ' غائب · ' + num(x.rate, true) + '</b></div>';
      }).join('') + '</div>' : '<div class="infoline">لا توجد بيانات</div>');
      html += '<div class="repbar">رابعاً: الطلاب الأكثر غياباً</div>' + tbl(['الطالب', 'الصف', 'أيام الغياب', 'غياب عن حصص', 'التأخر'],
        c.top.map(function (x) { return [name(x.s), cls(x.s), '<b>' + x.abs + '</b>', x.partial, x.late]; }));
      html += '<div class="repbar">خامساً: التزام المعلمين برصد الغياب</div>' +
        (c.teach.days ? '<div class="repsub">محسوب على ' + c.teach.days + ' يوم رُصد من التطبيق (الأيام المُدخلة من السجل الورقي واليوم الجاري لا تدخل): ' + c.teach.rec + ' حصة مرصودة من ' + c.teach.sched + '</div>' +
          tbl(['المعلم', 'حصص الجدول', 'الحصص المرصودة', 'لم تُرصد', 'نسبة الالتزام'], c.teach.list.map(function (x) {
            return [esc(x.t), x.sched, x.rec, x.sched - x.rec ? '<b class="neg">' + (x.sched - x.rec) + '</b>' : '0', '<b>' + x.rate + '%</b>'];
          })) : '<div class="infoline">لا توجد أيام مرصودة من التطبيق في هذه الفترة</div>');
      var b = c.beh;
      html += '<div class="repbar">سادساً: السلوك</div><div class="pks">' +
        kpi('د1', b.deg[0], (pb.deg || [])[0], false) + kpi('د2', b.deg[1], (pb.deg || [])[1], false) + kpi('د3', b.deg[2], (pb.deg || [])[2], false) +
        kpi('د4', b.deg[3], (pb.deg || [])[3], false) + kpi('د5', b.deg[4], (pb.deg || [])[4], false) +
        kpi('حالات مفتوحة', b.open, pb.open, false) + kpi('إحالات للموجه/اللجنة', b.referred, pb.referred, false) + kpi('درجات محسومة', b.deducted, pb.deducted, false) + kpi('ملاحظات عامة', b.notes, pb.notes, false) + '</div>' +
        (b.top.length ? '<div class="repsub">الطلاب الأكثر مشكلات في الفترة</div>' + tbl(['الطالب', 'الصف', 'عدد المشكلات'], b.top.map(function (x) { return [name(x.s), cls(x.s), x.n]; })) : '');
      html += '<div class="repbar">سابعاً: متابعة المعلمين</div><div class="pks">' + kpi('مخالفات مرصودة', c.viol.n, pv.n, false) + kpi('اتُّخذ فيها قرار', c.viol.decided, pv.decided, true) + '</div>' +
        (c.viol.list.length ? tbl(['المعلم', 'عدد المخالفات'], c.viol.list.map(function (x) { return [esc(x.t), x.n]; })) : '');
      html += '<div class="repsub" style="margin-top:14px">أُعدّ التقرير آلياً من سجلات الغياب والسلوك ومتابعة المعلمين بتاريخ ' + fmt(iso(new Date())) + ' – الأسهم الخضراء تحسّن والحمراء تراجع مقارنة بـ' + esc(R.pname) + '.</div></div>';
      document.getElementById('pbody').innerHTML = html;
    }
  }

  // ---------- حصص الانتظار ----------
  function viewSubs() {
    var d0 = todayISO();
    var S = { date: d0, teachers: [], absent: {}, slots: null, saved: [] };
    h('<div class="noprint"><button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button>' +
      '<h2>🔄 حصص الانتظار</h2>' +
      '<div class="card"><label>التاريخ <input type="date" id="sd" value="' + d0 + '"></label> <span id="sday" class="muted"></span>' +
      '<p class="muted" style="margin:.5em 0">حدّد المعلمين الغائبين ثم اضغط «توزيع تلقائي». الأولوية للأقل نصاباً في اليوم، وحصة واحدة لكل معلم، ورضا نبهان وياسر شبل آخر خيار.</p>' +
      '<div id="st" class="subs-t">جارٍ التحميل…</div>' +
      '<div class="vtools"><button class="btn" id="sgo">⚙️ توزيع تلقائي</button></div></div></div>' +
      '<div id="sres"></div>');
    var $st = document.getElementById('st'), $res = document.getElementById('sres');
    function load() {
      $st.textContent = 'جارٍ التحميل…'; $res.innerHTML = '';
      api('subGet', { date: S.date }).then(function (j) {
        S.teachers = j.teachers; S.saved = j.saved || []; S.absent = {};
        document.getElementById('sday').textContent = j.day + (j.holiday ? ' — إجازة' : '');
        S.saved.forEach(function (r) { S.absent[r.t] = 1; });
        $st.innerHTML = j.teachers.map(function (x) {
          return '<label class="chk" style="display:inline-block;min-width:12em;margin:.2em .4em"><input type="checkbox" data-t="' + esc(x.t) + '"' + (S.absent[x.t] ? ' checked' : '') + '> ' + esc(x.t) +
            ' <small class="muted">(' + x.load + ' حصص' + (x.prot ? ' · مستثنى' : '') + ')</small></label>';
        }).join('');
        Array.prototype.forEach.call($st.querySelectorAll('input[data-t]'), function (c) {
          c.onchange = function () { if (c.checked) S.absent[c.getAttribute('data-t')] = 1; else delete S.absent[c.getAttribute('data-t')]; };
        });
        if (S.saved.length) renderSaved();
      }).catch(function (e) { if (e.auth) return logout(true); $st.textContent = e.message; });
    }
    function renderSaved() {
      $res.innerHTML = '<div class="card"><h3>✅ التوزيع المعتمد ليوم ' + esc(S.date) + '</h3>' + table(S.saved, false) +
        '<div class="vtools noprint"><button class="btn small ghost" id="sprint">🖨️ طباعة</button></div></div>';
      document.getElementById('sprint').onclick = function () { window.print(); };
    }
    function table(rows, edit) {
      return '<div class="tscroll"><table class="vt"><thead><tr><th>الحصة</th><th>الفصل</th><th>المادة</th><th>المعلم الغائب</th><th>المعلم المنتظر</th></tr></thead><tbody>' +
        rows.map(function (r, i) {
          var cell;
          if (edit) {
            cell = '<select data-i="' + i + '"><option value="">— لم يُسند —</option>' + r.free.map(function (f) {
              return '<option value="' + esc(f.t) + '"' + (f.t === r.sub ? ' selected' : '') + '>' + esc(f.t) + ' (' + f.load + ')' + (f.prot ? ' · مستثنى' : '') + '</option>';
            }).join('') + '</select> <span class="xb" data-x="' + i + '"></span>';
          } else cell = esc(r.sub) + (r.extreme ? ' <b style="color:#e00000;font-size:1.3em;font-weight:900;white-space:nowrap">⚠ حالة قصوى</b>' : '');
          return '<tr><td>' + r.p + '</td><td>' + esc(r.c) + '</td><td>' + esc(r.s) + '</td><td>' + esc(r.t) + '</td><td>' + cell + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function recount() {
      var cnt = {};
      S.slots.forEach(function (r) { if (r.sub) cnt[r.sub] = (cnt[r.sub] || 0) + 1; });
      var dup = {};
      S.slots.forEach(function (r, i) {
        var prot = r.sub && r.free.some(function (f) { return f.t === r.sub && f.prot; });
        r.extreme = !!r.sub && (prot || cnt[r.sub] > 1);
        var k = r.sub + '|' + r.p; var bad = r.sub && dup[k]; if (r.sub) dup[k] = 1;
        var x = $res.querySelector('[data-x="' + i + '"]');
        if (x) x.innerHTML = bad ? '<b style="color:#e00000;font-size:1.3em;font-weight:900;white-space:nowrap">✖ مكرر في نفس الحصة</b>' : (r.extreme ? '<b style="color:#e00000;font-size:1.3em;font-weight:900;white-space:nowrap">⚠ حالة قصوى</b>' : '');
      });
    }
    function plan() {
      var absent = Object.keys(S.absent);
      if (!absent.length) return toast('حدّد معلماً غائباً واحداً على الأقل');
      $res.innerHTML = '<div class="card">جارٍ التوزيع…</div>';
      api('subPlan', { date: S.date, absent: absent }).then(function (j) {
        S.slots = j.slots;
        if (!S.slots.length) { $res.innerHTML = '<div class="card">لا توجد حصص للمعلمين المحددين في هذا اليوم.</div>'; return; }
        var un = S.slots.filter(function (r) { return !r.sub; }).length;
        $res.innerHTML = '<div class="card"><h3>المقترح (' + S.slots.length + ' حصة' + (un ? ' · ' + un + ' دون معلم فارغ' : '') + ')</h3>' +
          '<p class="muted">يمكنك تغيير المعلم المنتظر من القائمة (الرقم بين القوسين = نصابه ذلك اليوم).</p>' + table(S.slots, true) +
          '<div class="vtools"><button class="btn" id="ssave">✅ اعتماد وحفظ</button></div></div>';
        Array.prototype.forEach.call($res.querySelectorAll('select[data-i]'), function (s) {
          s.onchange = function () { S.slots[+s.getAttribute('data-i')].sub = s.value; recount(); };
        });
        recount();
        document.getElementById('ssave').onclick = save;
      }).catch(function (e) { if (e.auth) return logout(true); $res.innerHTML = '<div class="card">' + esc(e.message) + '</div>'; });
    }
    function save() {
      var b = document.getElementById('ssave'); b.disabled = true; b.textContent = 'جارٍ الحفظ…';
      var rows = S.slots.map(function (r) { return { p: r.p, c: r.c, s: r.s, t: r.t, sub: r.sub, extreme: r.extreme }; });
      api('subSave', { date: S.date, rows: rows }).then(function (j) {
        S.saved = j.saved; renderSaved(); toast('تم اعتماد حصص الانتظار');
        if (j.emails && j.emails.length) {
          var body = 'السلام عليكم،\nحصص الانتظار ليوم ' + S.date + ':\n' + rows.filter(function (r) { return r.sub; }).map(function (r) {
            return '• أ. ' + r.sub + ' — الحصة ' + r.p + ' — فصل ' + r.c + ' (' + r.s + ') بدلاً من أ. ' + r.t; }).join('\n') + '\n\nوكالة شؤون المعلمين';
          var url = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(j.emails.join(',')) + '&su=' + encodeURIComponent('حصص الانتظار ' + S.date) + '&body=' + encodeURIComponent(body);
          document.querySelector('#sres .vtools').insertAdjacentHTML('beforeend', ' <a class="btn small ghost" target="_blank" rel="noopener" href="' + url + '">✉️ إبلاغ المعلمين بالبريد</a>');
        }
      }).catch(function (e) { if (e.auth) return logout(true); toast(e.message, 5000); b.disabled = false; b.textContent = '✅ اعتماد وحفظ'; });
    }
    document.getElementById('sd').onchange = function () { S.date = this.value || todayISO(); load(); };
    document.getElementById('sgo').onclick = plan;
    load();
  }
  function loadMySubs() {
    var box = document.getElementById('mysubs'); if (!box || !state.token) return;
    api('subMine').then(function (j) {
      if (!j.list || !j.list.length) return;
      box.innerHTML = '<div class="card" style="border-right:4px solid #1A9BD7"><b>🔄 حصص الانتظار المسندة لك اليوم</b><ul style="margin:.4em 0 0">' +
        j.list.map(function (r) { return '<li>الحصة ' + r.p + ' — فصل ' + esc(r.c) + ' (' + esc(r.s) + ') بدلاً من أ. ' + esc(r.t) + '</li>'; }).join('') + '</ul></div>';
    }).catch(function () {});
  }

  // ---------- الرئيسية ----------
  function viewHome() {
    var u = state.user || {}, m = state.menu || { forms: [], views: [] };
    var html = '<div class="card userline"><div><b>' + esc(u.name || u.email) + '</b><div class="muted" dir="ltr" style="text-align:right">' + esc(u.email) + '</div></div>' +
      '<div><span class="role">' + esc(u.roleLabel || '') + '</span> <button id="out" class="btn small ghost">خروج</button></div></div>';
    html += '<div id="alerts"></div><div id="mysubs"></div><div id="kpis"></div>';
    if (m.subs || /admin|director|supervisor/.test((u.roles || []).join(','))) html += '<div class="grid"><a class="tile report" href="#/subs">🔄 حصص الانتظار<small>توزيع آلي حسب جدول المعلمين ونصاب اليوم</small></a></div>';
    if (m.visits || /admin|director|supervisor/.test((u.roles || []).join(','))) html += '<div class="grid"><a class="tile report" href="#/visits">🗓️ الزيارات الصفية وتقييم الأداء<small>أجندة الزيارات الشهرية، تقييم المعلم أثناء الحصة، وتقرير يُرسل له بالبريد وواتساب</small></a></div>';
    if (m.reports || /admin|director|supervisor/.test((u.roles || []).join(','))) html += '<div class="grid"><a class="tile report" href="#/report">📊 تقارير الأداء (أسبوعي / شهري)<small>قياس المدرسة في الأسبوع والشهر ومقارنتها بالفترة السابقة</small></a></div>';
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
    loadMySubs();
  }
  var homeSeq = 0;
  var SEEN = { abs_daily: 1 }; // خانات يختفي إشعارها بمجرد فتحها
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
      var n = Number(b[k].n) || 0;
      if (SEEN[k] && b[k].k && get('seen_' + k, '') === b[k].k) n = 0; // فُتح هذا اليوم: لا إشعار حتى يوم دراسي جديد
      total += n;
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
    var abs = isAbsPage(page), noAbs = abs && F.answers['__noabs_' + F.page] === true;
    if (F.page > 0 && page.help && !abs) html += '<p class="help">' + esc(page.help) + '</p>';
    if (abs) html += '<button type="button" id="noAbs" class="btn ' + (noAbs ? 'green' : 'ghost') + '" style="width:100%;margin:4px 0 12px">' + (noAbs ? '✓ لا يوجد غياب — جميع الطلاب حاضرون' : 'لا يوجد غياب (جميع الطلاب حاضرون)') + '</button>';
    if (abs && !noAbs) { html += absMatrix(page); page.items.forEach(function (it) { if (it.type !== 'checkbox') html += renderItem(it); }); }
    else page.items.forEach(function (it) { if (noAbs && it.type === 'checkbox') return; html += renderItem(it); });
    html += '</div>';
    if (errMsg) html += '<div class="err">' + esc(errMsg) + '</div>';
    var nt = nextTarget();
    html += '<div class="actions">' + (F.history.length ? '<button class="btn ghost" id="prev">السابق</button>' : '') +
      '<button class="btn ' + (nt < 0 ? 'green' : '') + '" id="next">' + (nt < 0 ? 'إرسال ✓' : 'التالي ←') + '</button></div>';
    h(html);
    bindItems(page);
    if (abs && !noAbs) bindAbsMatrix(page);
    document.getElementById('home').onclick = function () { location.hash = '#/home'; };
    var prev = document.getElementById('prev');
    if (prev) prev.onclick = function () { F.page = F.history.pop(); saveDraft(); renderPage(); };
    document.getElementById('next').onclick = onNext;
    var nb = document.getElementById('noAbs');
    if (nb) nb.onclick = function () {
      var k = '__noabs_' + F.page, on = F.answers[k] !== true;
      if (on) page.items.forEach(function (it) { if (it.type === 'checkbox') delete F.answers[it.id]; });
      F.answers[k] = on; saveDraft(); renderPage();
    };
  }

  // نموذج الغياب: اسم الطالب وأمامه أزرار الحالة (غاب حصة / غاب يوم كامل / متأخر / مستأذن)
  // يكتب في قوائم النموذج نفسها، فلا يتغيّر شيء في نموذج Google أو في الملفات
  var ABS_COLS = [[/الغائبون عن الحصة/, 'غاب حصة', 'p'], [/اليوم/, 'غاب يوم كامل', 'd'], [/المتأخر/, 'متأخر', 'l'], [/المستأذن/, 'مستأذن', 'e']];
  function absCols(page) {
    var cbs = page.items.filter(function (it) { return it.type === 'checkbox'; }), cols = [];
    var used = function (x) { return cols.some(function (y) { return y.it === x; }); };
    ABS_COLS.forEach(function (c) { var it = cbs.filter(function (x) { return c[0].test(x.title) && !used(x); })[0]; if (it) cols.push({ it: it, t: c[1], k: c[2] }); });
    cbs.forEach(function (x) { if (!used(x)) cols.push({ it: x, t: x.title.replace(/\s*\([^)]*\)\s*$/, ''), k: 'o' }); });
    return cols;
  }
  function absNames(cols) { var n = []; cols.forEach(function (c) { c.it.choices.forEach(function (ch) { if (n.indexOf(ch.v) < 0) n.push(ch.v); }); }); return n; }
  function absState(cols, name) { for (var i = 0; i < cols.length; i++) { var a = F.answers[cols[i].it.id]; if (Array.isArray(a) && a.indexOf(name) >= 0) return i; } return -1; }
  function absCss() {
    if (document.getElementById('absCss')) return;
    var st = document.createElement('style'); st.id = 'absCss';
    st.textContent = '.abssum{background:var(--blue-l);color:var(--blue-d);border-radius:10px;padding:8px 12px;margin:6px 0 10px;font-weight:700;font-size:15px}' +
      '.absm{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}' +
      '.absrow{padding:10px 10px 12px;border-bottom:1px solid #eef2f4}.absrow:last-child{border-bottom:0}.absrow.has{background:#fbfcf7}' +
      '.absname{font-weight:700;margin-bottom:8px;font-size:16px}' +
      '.absbtns{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}' +
      '.absb{border:1.5px solid var(--line);background:#fff;border-radius:10px;padding:10px 2px;font:inherit;font-size:14px;font-weight:700;color:var(--muted);cursor:pointer;line-height:1.25}' +
      '.absb.kp.on{background:#e67e22;border-color:#e67e22;color:#fff}.absb.kd.on{background:var(--err);border-color:var(--err);color:#fff}' +
      '.absb.kl.on{background:#d4a017;border-color:#d4a017;color:#fff}.absb.ke.on{background:var(--blue);border-color:var(--blue);color:#fff}.absb.ko.on{background:var(--green);border-color:var(--green);color:#fff}' +
      '@media (max-width:360px){.absb{font-size:12.5px}}';
    document.head.appendChild(st);
  }
  function absMatrix(page) {
    absCss();
    var cols = absCols(page), names = absNames(cols);
    var html = '<div class="item"><label class="q">اضغط الحالة المناسبة أمام اسم الطالب. من لا تضغط له شيئاً يُعدّ حاضراً، والضغط مرة ثانية يلغي الاختيار.</label>';
    if (names.length > 12) html += '<input type="search" id="absFilter" placeholder="🔎 ابحث بالاسم…" value="' + esc(F.filters.__abs || '') + '" style="margin:6px 0">';
    html += '<div class="abssum" id="absSum"></div><div class="absm">';
    names.forEach(function (n, ri) {
      var s = absState(cols, n);
      html += '<div class="absrow' + (s >= 0 ? ' has' : '') + '" data-r="' + ri + '"><div class="absname">' + (ri + 1) + '. ' + esc(n) + '</div><div class="absbtns">' + cols.map(function (c, ci) {
        return '<button type="button" class="absb k' + c.k + (s === ci ? ' on' : '') + '" data-r="' + ri + '" data-c="' + ci + '">' + esc(c.t) + '</button>';
      }).join('') + '</div></div>';
    });
    return html + '</div></div>';
  }
  function bindAbsMatrix(page) {
    var cols = absCols(page), names = absNames(cols);
    var sum = function () {
      var el = document.getElementById('absSum'); if (!el) return;
      var parts = cols.map(function (c) { var a = F.answers[c.it.id], k = Array.isArray(a) ? a.length : 0; return k ? c.t + ': ' + k : ''; }).filter(Boolean);
      el.textContent = parts.length ? parts.join('  •  ') : 'لم تحدّد أحداً بعد (الجميع حاضرون)';
    };
    sum();
    $app.querySelectorAll('.absb').forEach(function (b) {
      b.onclick = function () {
        var ri = +b.dataset.r, ci = +b.dataset.c, n = names[ri], was = absState(cols, n), on = was !== ci;
        cols.forEach(function (c) { var a = F.answers[c.it.id]; if (Array.isArray(a)) { a = a.filter(function (x) { return x !== n; }); if (a.length) F.answers[c.it.id] = a; else delete F.answers[c.it.id]; } });
        if (on) F.answers[cols[ci].it.id] = (F.answers[cols[ci].it.id] || []).concat([n]);
        var row = b.parentNode.parentNode;
        row.querySelectorAll('.absb').forEach(function (x) { x.classList.toggle('on', on && +x.dataset.c === ci); });
        row.classList.toggle('has', on);
        saveDraft(); sum();
      };
    });
    var f = document.getElementById('absFilter');
    if (f) {
      var ap = function () { var q = f.value.trim(); F.filters.__abs = q; $app.querySelectorAll('.absrow').forEach(function (r) { r.style.display = !q || names[+r.dataset.r].indexOf(q) >= 0 ? '' : 'none'; }); };
      f.addEventListener('input', ap); ap();
    }
  }
  // صفحة صف في نموذج الغياب: فيها قوائم طلاب (اختيار متعدد)
  function isAbsPage(page) {
    return F.key === 'absence' && F.page > 0 && page.items.some(function (it) { return it.type === 'checkbox'; });
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
      body = '<textarea data-id="' + it.id + '">' + esc(a || '') + '</textarea>' + (F.key === 'behavior' && /^وصف الموقف/.test(it.title) ? '<div class="sugg" data-sugg="' + it.id + '"></div>' : '');
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
    behSuggest(page);
  }

  // ===== مصنّف المشكلات السلوكية بالكلمات المفتاحية (بدون ذكاء اصطناعي) =====
  var AMJ_SYN = [
    ['تاخر متاخر اتاخر تاخير متاخرا', 'تاخر'],
    ['هرب هروب يهرب شرد زوغ تزويغ طفش', 'هروب'],
    ['ضرب ضربه يضرب لكم لكمه صفع كف ركل رفس دفع دفعه اعتدي اعتداء عض خنق', 'ضرب'],
    ['شتم يشتم سب يسب سبه شتيمه شتائم بذيء بذيئه بذيئا وقاحه لعن يلعن الفاظ', 'نابيه الفاظ'],
    ['سخر يسخر سخريه استهزا يستهزئ استهزاء يتمسخر تريق يتريق', 'سخريه'],
    ['تنمر يتنمر', 'تنمر'],
    ['هدد يهدد تهديد توعد', 'تهديد'],
    ['نام نايم ينام نوم نعسان', 'نوم'],
    ['اكل ياكل شرب يشرب علك علكه شيبس حلويات اكله سندويش عصير', 'اطعمه مشروبات'],
    ['زي ثوب شماغ غتره لبس ملابس بنطلون تيشيرت جاكيت قبعه كاب شعر قصه', 'زي'],
    ['صور يصور صوره تصوير فيديو مقطع سجل يسجل تسجيل جوال جواله موبايل هاتف تلفون', 'تصوير تسجيل'],
    ['سرق يسرق سرقه سارق', 'سرقه'],
    ['كسر يكسر خرب يخرب تخريب اتلف اتلاف حطم طاوله كرسي باب زجاج سبوره', 'اتلاف تجهيزات ضرر مباني'],
    ['خربش جدار الجدار جدران الجدران', 'جدران عبث تجهيزات'],
    ['حصه الحصه حصص الحصص', 'حصه حصص'],
    ['يتكلم يتحدث سوالف يسولف يقاطع مقاطعه', 'حديث جانبي مقاطعه'],
    ['فوضي ازعاج ازعج يزعج صراخ صرخ يصرخ شغب دوشه ضجه هرج لعب يلعب مشاغب', 'فوضي'],
    ['هوشه مضاربه تضارب عراك تعارك مشاجره تشاجر تهاوش اشتبك', 'شجار مضاربه'],
    ['دخان سيجاره سجائر سيجاره سيقاره فيب شيشه معسل', 'سجائر'],
    ['يدخن تدخين دخن مدخن', 'تدخين'],
    ['سكين سكينه سكاكين موس شفره مشرط', 'اله حاده سكاكين'],
    ['مسدس سلاح رصاص', 'اسلحه'],
    ['مخدرات حبوب حشيش مخدر', 'مخدرات'],
    ['طابور اصطفاف', 'اصطفاف'],
    ['خرج طلع يطلع خروج', 'خروج'],
    ['دخل يدخل', 'دخول'],
    ['اذن استئذان استاذان', 'استئذان'],
    ['مزق يمزق رمي', 'امتهان كتب'],
    ['وقع توقيع زور تزوير', 'توقيع'],
    ['تحرش يتحرش', 'تحرش'],
    ['نار ولع ولاعه حرق اشعل', 'اشعال النار'],
    ['مفرقعات طراطيع بخاخ العاب ناريه', 'خطره العاب'],
    ['بوابه البوابه', 'بوابه'],
    ['معلم المعلم معلمه الاستاذ استاذ مدرس اداري الوكيل المدير منسوبي', 'المعلمين'],
    ['افتراضي افتراضيه منصه مدرستي تيمز اونلاين بعد', 'افتراضيه'],
    ['ابتزاز ابتز يبتز', 'ابتزاز'],
    ['الدين الاسلام الصلاه القران', 'شعائر الاسلام'],
    ['الدوله الملك الوطن', 'الدوله رموزها'],
    ['عنصريه قبيله قبليه', 'عنصريه'],
    ['غاب يغب غياب حضر يحضر', 'حضور']
  ];
  var AMJ_STOP = ' في من علي عن الي الطالب طالب مع او و ثم كان قام بعد قبل اثناء هذا هذه ذلك التي الذي ما لا لم لن قد كل اي حال داخل اليوم وقت زميل زميله زملاء زملاءه ';
  var AMJ_PHR = [
    [/(طلع|خرج|هرب|شرد)\s+(من\s+)?(المدرسه|الدوام|المبني)/, 'هروب مدرسه', 'خروج طلع خرج استيذان اذن'],
    [/كتب\s+(علي\s+)?(ال)?جدار/, 'جدران عبث تجهيزات'],
    [/(بدون|بلا|غير|دون)\s+(اذن|استئذان)/, 'استئذان'],
    [/(ما|لم)\s+(يحضر|حضر|يدخل|دخل)\s+(ال)?(حصه|حصص)/, 'عدم حضور حصه'],
    [/(ما|لم)\s+(يحضر|حضر)\s+(ال)?(طابور|اصطفاف)/, 'عدم حضور اصطفاف'],
    [/تاخر\s+(عن|في|علي)?\s*(ال)?(حصه|حصص|درس)/, 'تاخر دخول حصص'],
    [/فصل\s+(اخر|ثاني|ثان)/, 'فصل اخر'],
    [/(معه|بحوزته|عنده|شنطته|جيبه|حقيبته)/, 'حيازه']
  ];
  function amjNorm_(s) {
    return String(s || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[^\u0621-\u064Aa-z0-9]+/gi, ' ').trim();
  }
  function amjStem_(w) {
    if (w.length > 4 && /^(وال|بال|فال|كال)/.test(w)) w = w.slice(3);
    else if (w.length > 3 && /^(ال|لل)/.test(w)) w = w.slice(2);
    else if (w.length > 4 && w[0] === 'و') w = w.slice(1);
    if (w.length > 5 && /(ات|ين|ون|هم|ها)$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 4 && /[هي]$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  function amjToks_(s, syn) {
    var ns = amjNorm_(s), words = ns.split(' ').filter(Boolean), out = [], drop = [], strong = [];
    if (syn) AMJ_PHR.forEach(function (p) { if (p[0].test(ns)) { amjNorm_(p[1]).split(' ').forEach(function (c) { out.push(c); strong.push(c); }); if (p[2]) drop = drop.concat(p[2].split(' ')); } });
    words.forEach(function (w) {
      if (syn) AMJ_SYN.forEach(function (p) {
        var keys = amjNorm_(p[0]).split(' ');
        if (keys.indexOf(w) >= 0 || keys.indexOf(amjStem_(w)) >= 0 || (w.length > 4 && keys.indexOf(w.replace(/^(و|ف|ب)/, '')) >= 0))
          amjNorm_(p[1]).split(' ').forEach(function (c) { out.push(c); });
      });
      out.push(w);
    });
    var res = out.map(amjStem_).filter(function (w) { return w.length > 1 && AMJ_STOP.indexOf(' ' + w + ' ') < 0 && drop.indexOf(w) < 0; })
      .filter(function (w, i, a) { return a.indexOf(w) === i; });
    res.strong = strong.map(amjStem_);
    return res;
  }
  function amjHit_(q, L) {
    for (var i = 0; i < L.length; i++) {
      var l = L[i];
      if (l === q) return true;
      if (q.length >= 3 && l.length >= 3 && (l.indexOf(q) === 0 || q.indexOf(l) === 0) && Math.abs(l.length - q.length) <= 2) return true;
    }
    return false;
  }
  /** يرجع أقرب المشكلات من القائمة لوصف الموقف: [{label, score}] */
  function amjSuggest(desc, labels, n) {
    var Q = amjToks_(desc, true); if (!Q.length) return [];
    var nd = amjNorm_(desc);
    var online = /افتراض|منصه|مدرستي|تيمز|اونلاين|عن بعد/.test(nd);
    var staff = /معلم|استاذ|مدرس|اداري|الوكيل|المدير|منسوب/.test(nd) && /ضرب|سخر|استهز|هدد|تهديد|شتم|سب|وقاح|صور|تصوير|ابتز|الفاظ|بذي|اعتد|وقع|توقيع|سرق|اتلف|كسر/.test(nd);
    var LT = labels.map(function (l) { return amjToks_(String(l).replace(/^\([^)]*\)\s*/, ''), false); });
    var df = {}; Q.forEach(function (q) { df[q] = 0; LT.forEach(function (L) { if (amjHit_(q, L)) df[q]++; }); });
    var N = labels.length;
    var res = labels.map(function (lab, i) {
      var L = LT[i], s = 0, hits = 0;
      Q.forEach(function (q) { if (df[q] && amjHit_(q, L)) { s += Math.log(1 + N / df[q]) * ((Q.strong || []).indexOf(q) >= 0 ? 1.8 : 1); hits++; } });
      if (!hits) return { label: lab, score: 0 };
      s = s / (1 + 0.04 * L.length);
      var isOn = /عن بعد/.test(lab), isStaff = /المعلمين|منسوبي المدرسه|منسوبي المدرسة/.test(lab);
      if (isOn !== online) s *= 0.45;
      if (isStaff && !staff) s *= 0.5;
      if (!isStaff && staff) s *= 0.5;
      return { label: lab, score: Math.round(s * 100) / 100 };
    }).filter(function (r) { return r.score >= 0.9; }).sort(function (a, b) { return b.score - a.score; });
    return res.slice(0, n || 3);
  }

  // ---------- اقتراح تصنيف المشكلة السلوكية من وصف المعلم (كلمات مفتاحية – بدون ذكاء اصطناعي) ----------
  function behSuggest(page) {
    if (F.key !== 'behavior') return;
    var pick = function (re, needChoices) { return page.items.filter(function (it) { return re.test(it.title || '') && (!needChoices || it.choices); })[0]; };
    var desc = pick(/^وصف الموقف/), prob = pick(/^المشكلة السلوكية/, true), typ = pick(/^نوع الملاحظة/, true);
    if (!desc || !prob) return;
    var ta = $app.querySelector('textarea[data-id="' + desc.id + '"]'), box = $app.querySelector('[data-sugg="' + desc.id + '"]');
    if (!ta || !box) return;
    var labels = prob.choices.map(function (c) { return c.v; });
    var draw = function () {
      var txt = ta.value.trim();
      if (txt.length < 4 || (typ && F.answers[typ.id] && !/مشكلة/.test(F.answers[typ.id]))) { box.innerHTML = ''; return; }
      var list = amjSuggest(txt, labels, 3);
      if (!list.length) { box.innerHTML = '<div class="help" style="margin-top:6px">لم يُعثر على تصنيف مناسب — اختر المشكلة من القائمة أعلاه.</div>'; return; }
      box.innerHTML = '<div class="help" style="margin-top:6px">🔎 تصنيف مقترح من الوصف — اضغط لاختياره:</div>' + list.map(function (r, i) {
        var on = F.answers[prob.id] === r.label;
        return '<button type="button" class="pill' + (on ? ' on' : '') + '" data-sg="' + i + '" style="display:block;width:100%;text-align:right;margin:4px 0;white-space:normal;line-height:1.5">' + (on ? '✓ ' : '') + esc(r.label) + '</button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-sg]'), function (b) {
        b.onclick = function () {
          var lab = list[+b.getAttribute('data-sg')].label;
          F.answers[prob.id] = lab;
          var sel = $app.querySelector('select[data-id="' + prob.id + '"]'); if (sel) sel.value = lab;
          if (typ) {
            var pc = typ.choices.filter(function (c) { return /مشكلة/.test(c.v); })[0];
            if (pc && F.answers[typ.id] !== pc.v) {
              F.answers[typ.id] = pc.v;
              Array.prototype.forEach.call($app.querySelectorAll('.pill[data-id="' + typ.id + '"]'), function (p) { p.classList.toggle('on', typ.choices[+p.dataset.i].v === pc.v); });
              var ts = $app.querySelector('select[data-id="' + typ.id + '"]'); if (ts) ts.value = pc.v;
            }
          }
          saveDraft(); draw(); toast('تم اختيار المشكلة ✓');
        };
      });
    };
    var tmr; ta.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(draw, 300); });
    draw();
  }

  function validatePage() {
    var page = F.def.pages[F.page];
    for (var i = 0; i < page.items.length; i++) {
      var it = page.items[i];
      if (it.required && isEmpty(F.answers[it.id])) return 'الحقل «' + it.title + '» مطلوب';
      if (String(F.answers[it.id] || '').indexOf('__MISSING__') === 0) return 'اسمك غير موجود في قائمة النموذج. راجع الوكيل.';
    }
    if (isAbsPage(page) && F.answers['__noabs_' + F.page] !== true &&
        !page.items.some(function (it) { return it.type === 'checkbox' && !isEmpty(F.answers[it.id]); }))
      return 'حدّد الطلاب الغائبين أو المتأخرين، أو اضغط «لا يوجد غياب».';
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
    try { var hb = (get('home', {}).badges || {})[key]; if (SEEN[key] && hb && hb.k) set('seen_' + key, hb.k); } catch (e) {}
    var back = '<button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button>';
    var V = null, refreshing = false;
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
    // عمود التاريخ في الجدول (للتصفية بيوم معيّن)، أو -1
    function dateCol(sec) {
      if (!sec.header) return -1;
      for (var i = 0; i < sec.header.length; i++) if (/تاريخ/.test(txt(sec.header[i].t))) return i;
      return -1;
    }
    // زر واتساب ولي الأمر: إن لم يصل الرابط جاهزاً من الملف نبنيه من «الجوال» و«نص الرسالة»
    function waFix(sec) {
      if (sec.type !== 'table') return sec;
      var hs = sec.header.map(function (h) { return txt(h.t); });
      var pi = hs.indexOf('الجوال'), mi = hs.indexOf('نص الرسالة'), wi = -1;
      hs.forEach(function (t, i) { if (wi < 0 && /^واتساب/.test(t)) wi = i; });
      if (pi < 0 || mi < 0 || wi < 0) return sec;
      sec.rows.forEach(function (r) {
        var c = r.cells[wi], ph = txt(r.cells[pi]).replace(/\D/g, ''), msg = txt(r.cells[mi]);
        if ((!c || typeof c !== 'object') && ph && msg) r.cells[wi] = { t: '📲 إرسال', l: 'https://wa.me/' + ph + '?text=' + encodeURIComponent(msg) };
        hs.forEach(function (t, i) { if (i !== wi && /^واتساب/.test(t) && typeof r.cells[i] !== 'object') r.cells[i] = ''; }); // لا نعرض زراً بلا رابط
      });
      return sec;
    }
    // قائمة الغائبين والمتأخرين مع زر الإرسال، تُعرض داخل «التقرير اليومي» و«لوحة المتابعة»
    var ABS_IN = { abs_daily: 1, beh_dash: 1 };
    function hasView(k) { return (state.menu.views || []).some(function (x) { return x.key === k; }); }
    function absBox(v) {
      var box = document.getElementById('absbox'); if (!box) return;
      box.innerHTML = '<h2 class="sub">📲 إشعار أولياء أمور الغائبين والمتأخرين</h2><div class="loading">جارٍ تحميل القائمة…</div>';
      api('view', { viewKey: 'abs_today' }).then(function (j) {
        if (V !== v || !document.getElementById('absbox')) return;
        var sec = null;
        j.view.sections.forEach(function (x) { if (!sec && x.type === 'table' && x.header.some(function (h) { return txt(h.t) === 'الطالب'; })) sec = waFix(x); });
        var d = j.view.date && j.view.date.value ? j.view.date.value.replace(/-/g, '/') : '';
        var head = '<h2 class="sub">📲 إشعار أولياء أمور الغائبين والمتأخرين' + (d ? ' – ' + esc(d) : '') + '</h2>';
        if (!sec || !sec.rows.length) { box.innerHTML = head + '<div class="infoline">لا يوجد غائبون أو متأخرون مرصودون في هذا اليوم ✓</div>'; return; }
        var keep = []; sec.header.forEach(function (h, i) { var t = txt(h.t); if (t !== 'نص الرسالة' && t !== 'الجوال') keep.push(i); });
        var small = { type: 'table', header: keep.map(function (i) { return sec.header[i]; }),
          rows: sec.rows.map(function (r) { return { r: r.r, key: r.key, cells: keep.map(function (i) { return r.cells[i]; }) }; }) };
        box.innerHTML = head + (key === 'beh_dash' ? '<div class="muted small">لتغيير اليوم افتح لوحة «اليوم» أو «التقرير اليومي» وغيّر التاريخ منها.</div>' : '') + tableHtml(small, 'abs');
        applyFilter();
      }).catch(function (e) {
        if (e.auth) return logout(true);
        var b = document.getElementById('absbox'); if (b) b.innerHTML = '<h2 class="sub">📲 إشعار أولياء أمور الغائبين والمتأخرين</h2><div class="err">تعذر تحميل القائمة، اضغط «تحديث».</div>';
      });
    }
    // تصفية الصفوف: البحث + اليوم المختار
    function applyFilter() {
      var q = document.getElementById('q'), fs = document.getElementById('fsel');
      var s = q ? q.value.trim() : '', d = fs ? fs.value : '';
      var shown = 0, all = $app.querySelectorAll('tr.data');
      all.forEach(function (tr) {
        var on = (!s || tr.textContent.indexOf(s) >= 0) && (!d || !tr.hasAttribute('data-d') || tr.getAttribute('data-d') === d);
        tr.style.display = on ? '' : 'none'; if (on) shown++;
      });
      $app.querySelectorAll('table.sheet').forEach(function (tb) {
        var n = 0; tb.querySelectorAll('tr.data').forEach(function (tr) { if (tr.style.display !== 'none') n++; });
        var w = tb.parentNode.previousElementSibling, c = w && w.querySelector('.tc'); if (c) c.textContent = n;
      });
      var nr = document.getElementById('nores');
      if (nr) { nr.textContent = d && !s ? 'لا توجد سجلات في هذا اليوم' : 'لا توجد نتائج لهذا البحث في هذه اللوحة'; nr.classList.toggle('hidden', (!s && !d) || shown > 0 || !all.length); }
    }
    function filterBar(v) {
      var counts = {}, any = false;
      v.sections.forEach(function (sec) {
        if (sec.type !== 'table') return; var di = dateCol(sec); if (di < 0) return; any = true;
        sec.rows.forEach(function (r) { var d = toISO(txt(r.cells[di])); if (d) counts[d] = (counts[d] || 0) + 1; });
      });
      if (!any) return '';
      var opts = schoolDays(30); Object.keys(counts).forEach(function (d) { if (opts.indexOf(d) < 0) opts.push(d); });
      opts.sort().reverse();
      return '<div class="datebar"><label for="fsel">📅 عرض سجلات يوم</label><select id="fsel"><option value="">كل الأيام</option>' +
        opts.map(function (d) { return '<option value="' + d + '">' + dayLabel(d) + (counts[d] ? '  (' + counts[d] + ')' : '') + '</option>'; }).join('') + '</select></div>';
    }
    var DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    function dayLabel(s) { var p = s.split('-'), x = new Date(+p[0], +p[1] - 1, +p[2]); return DAYS[x.getDay()] + '  ' + p[0] + '/' + p[1] + '/' + p[2]; }
    function schoolDays(n) {
      var out = [], t = new Date();
      for (var k = 0; out.length < n && k < n * 2; k++) {
        var x = new Date(t.getFullYear(), t.getMonth(), t.getDate() - k);
        if (x.getDay() === 5 || x.getDay() === 6) continue;
        out.push(x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2));
      }
      return out;
    }
    function tableHtml(sec, si) {
      var heads = sec.header.map(function (h) { return txt(h.t); });
      var di = dateCol(sec);
      var html = '<div class="tcount"><span class="tc">' + sec.rows.length + '</span> سجل</div><div class="tablewrap pro"><table class="sheet pro"><thead><tr>' + (sec.edit ? '<th>إجراء</th>' : '') +
        heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
      if (!sec.rows.length) html += '<tr><td colspan="' + (heads.length + 1) + '" class="emptyrow">لا توجد سجلات حالياً ✓</td></tr>';
      sec.rows.forEach(function (r, ri) {
        html += '<tr class="data"' + (di >= 0 ? ' data-d="' + esc(toISO(txt(r.cells[di]))) + '"' : '') + '>' + (sec.edit ? '<td class="act"><button class="btn small" data-edit="' + si + ':' + ri + '">✏️ قرار / تعديل</button></td>' : '') + r.cells.map(function (c, ci) {
          var t = txt(c);
          return '<td data-label="' + esc(heads[ci]) + '"' + (t === '' ? ' class="empty"' : '') + '>' + cellHtml(c, heads[ci]) + '</td>';
        }).join('') + '</tr>';
      });
      return html + '</tbody></table></div>';
    }
    // ---------- تقارير الطالب (بنفس شكل التقرير في الملف) ----------
    function repTable(s) {
      var heads = s.header.map(function (x) { return txt(x.t); });
      var rows = s.rows.filter(function (r) { return r.cells.some(function (c) { return txt(c).trim() !== ''; }); });
      var keep = heads.map(function (hh, i) { return hh.trim() !== '' || rows.some(function (r) { return txt(r.cells[i]).trim() !== ''; }); });
      var idx = []; keep.forEach(function (k, i) { if (k) idx.push(i); });
      if (!idx.length) return '';
      var kv = heads.length && /:$|^اسم الطالب/.test(heads[0].trim());
      if (kv) { // بيانات الطالب: أزواج (البيان ← القيمة) أسهل قراءة على الجوال
        var pairs = '';
        [heads].concat(rows.map(function (r) { return r.cells.map(txt); })).forEach(function (cells) {
          var ne = cells.map(function (x) { return String(x).trim(); }).filter(String);
          for (var q = 0; q < ne.length; q += 2) pairs += '<div><span>' + esc(ne[q].replace(/:$/, '')) + '</span><b>' + esc(ne[q + 1] || '') + '</b></div>';
        });
        return '<div class="kvgrid">' + pairs + '</div>';
      }
      var out = '<div class="repwrap"><table class="rept' + (kv ? ' kv' : '') + '"><thead><tr>' + idx.map(function (i) { return '<th>' + esc(heads[i]) + '</th>'; }).join('') + '</tr></thead><tbody>';
      rows.forEach(function (r) { out += '<tr>' + idx.map(function (i) { return '<td>' + cellHtml(r.cells[i], heads[i]) + '</td>'; }).join('') + '</tr>'; });
      return out + '</tbody></table></div>';
    }
    function drawReport(v) {
      V = v;
      var p = v.pick, secs = v.sections, ti = -1;
      secs.forEach(function (s, i) { if (ti < 0 && s.type === 'text' && /تقرير/.test(s.text)) ti = i; });
      var conf = secs.some(function (s) { return s.type === 'text' && /CONFIDENTIAL|سري للغاية/.test(s.text); });
      var body = '', sub = true;
      for (var i = ti + 1; i < secs.length; i++) {
        var s = secs[i];
        if (s.type !== 'text') { body += repTable(s); continue; }
        var t = s.text;
        if (/^الطالب:/.test(t)) continue;
        if (sub) { sub = false; if (!/^(أولاً|ثانياً)/.test(t)) { body += '<div class="repsub">' + esc(t) + '</div>'; continue; } }
        if (/^(أولاً|ثانياً|ثالثاً|رابعاً|خامساً|سادساً|سابعاً|ثامناً)/.test(t)) { body += '<div class="repbar">' + esc(t) + '</div>'; continue; }
        var nx = secs[i + 1];
        if (/\s·\s/.test(t) && nx && nx.type === 'text' && /\/\s*100/.test(nx.text)) {
          var L = t.split(/\s+·\s+/), S = nx.text.split(/\s+·\s+/), n2 = secs[i + 2], St = (n2 && n2.type === 'text' && !/^(أولاً|ثانياً|ثالثاً|رابعاً)/.test(n2.text)) ? n2.text.split(/\s+·\s+/) : [];
          body += '<div class="scores">' + L.map(function (l, k) { return '<div><span>' + esc(l) + '</span><b dir="ltr">' + esc(S[k] || '') + '</b><small>' + esc(St[k] || '') + '</small></div>'; }).join('') + '</div>';
          i += St.length ? 2 : 1; continue;
        }
        body += '<p class="repnote">' + esc(t) + '</p>';
      }
      var html = back + '<div class="vtools rtools"><button class="btn small ghost" id="ref">↻ تحديث</button>' +
        (meta.url ? '<a class="btn small ghost" target="_blank" rel="noopener" href="' + esc(meta.url) + '">فتح الملف</a>' : '') + '</div>' +
        '<div class="reppick"><label for="pk">👤 ' + esc(p.label) + '</label><input id="pk" list="pkl" value="' + esc(p.value) + '" placeholder="اكتب اسم الطالب أو الصف…" autocomplete="off">' +
        '<datalist id="pkl">' + p.options.map(function (o) { return '<option value="' + esc(o) + '">'; }).join('') + '</datalist><button class="btn small" id="pkgo">عرض التقرير</button></div>' +
        (p.send ? '<button class="btn wa repsend" id="repsend">📲 إرسال التقرير لولي الأمر (PDF عبر واتساب)</button>' : '') +
        '<div class="rep"><div class="rephead"><img src="icons/icon-512.png" alt=""><div><b>مدارس الأمجاد العالمية</b><span>AL-AMJAD INTERNATIONAL SCHOOLS</span><i>Learning for the life</i></div>' +
        (conf ? '<em class="conf">سري للغاية<br>CONFIDENTIAL</em>' : '') + '</div>' +
        '<div class="reptitle">' + esc(ti >= 0 ? secs[ti].text : v.title) + '</div>' + body + '</div>' +
        '<div class="muted small">آخر تحديث: ' + esc(fmtTime(v.updatedAt)) + '</div>';
      h(html);
      document.getElementById('ref').onclick = load;
      var pk = document.getElementById('pk'), go = document.getElementById('pkgo');
      function pickNow() {
        var val = pk.value.trim();
        if (p.options.indexOf(val) < 0) { toast('اختر الطالب من القائمة'); return; }
        if (val === p.value) return;
        go.disabled = true; go.textContent = 'جارٍ التحميل…';
        api('pick', { viewKey: key, value: val }, 60000).then(function () { load(); })
          .catch(function (e) { go.disabled = false; go.textContent = 'عرض التقرير'; if (e.auth) return logout(true); toast(e.net ? 'تعذر الاتصال' : e.message); });
      }
      go.onclick = pickNow;
      pk.onchange = function () { if (p.options.indexOf(pk.value.trim()) >= 0) pickNow(); };
      pk.onkeydown = function (e) { if (e.key === 'Enter') pickNow(); };
      var sb = document.getElementById('repsend');
      if (sb) sb.onclick = function () {
        sb.disabled = true; sb.textContent = 'جارٍ تجهيز ملف PDF… (حتى 30 ثانية)';
        api('reportPdf', { value: p.value }, 120000).then(function (r) {
          sb.disabled = false; sb.textContent = '📲 إرسال التقرير لولي الأمر (PDF عبر واتساب)';
          var ov = document.createElement('div'); ov.className = 'overlay';
          ov.innerHTML = '<div class="sheetbox" role="dialog" aria-modal="true"><div class="sheethead"><b>✓ تقرير ' + esc(r.student || p.value) + ' جاهز</b><button class="x" id="rcl" aria-label="إغلاق">✕</button></div>' +
            '<div class="sheetbody"><p>تُفتح رسالة واتساب جاهزة لولي الأمر وفيها رابط ملف PDF، راجعها ثم اضغط إرسال.</p>' +
            (r.wa ? '<a class="btn wa" href="' + esc(r.wa) + '" target="_blank" rel="noopener">📲 إرسال لولي الأمر (واتساب)</a>' : '<div class="warnbox">لا يوجد رقم لولي الأمر في الملف</div>') +
            '<a class="btn ghost" href="' + esc(r.pdf) + '" target="_blank" rel="noopener">📄 فتح ملف PDF</a></div>' +
            '<div class="actions"><button class="btn ghost" id="rln">إغلاق</button></div></div>';
          document.body.appendChild(ov);
          var close = function () { ov.remove(); };
          ov.onclick = function (e) { if (e.target === ov) close(); };
          document.getElementById('rcl').onclick = close; document.getElementById('rln').onclick = close;
        }).catch(function (e) {
          sb.disabled = false; sb.textContent = '📲 إرسال التقرير لولي الأمر (PDF عبر واتساب)';
          if (e.auth) return logout(true); toast(e.net ? 'تعذر الاتصال، حاول مرة أخرى' : e.message);
        });
      };
    }
    function draw(v) {
      if (v.pick) return drawReport(v);
      V = v;
      v.sections.forEach(waFix);
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
        (v.date ? dateBar(v.date) : filterBar(v)) +
        '<div class="toolbar"><input type="search" id="q" placeholder="🔎 ابحث في هذه اللوحة باسم طالب أو معلم…"></div><div id="nores" class="warnbox hidden">لا توجد نتائج لهذا البحث في هذه اللوحة</div>' +
        '<div class="muted small">آخر تحديث: ' + esc(fmtTime(v.updatedAt)) + '</div>' + body +
        (ABS_IN[key] && hasView('abs_today') ? '<div id="absbox"></div>' : '');
      h(html);
      absBox(v);
      var q = document.getElementById('q');
      q.oninput = applyFilter;
      var fs = document.getElementById('fsel'); if (fs) fs.onchange = applyFilter;
      document.getElementById('ref').onclick = function () {
        var b = this; b.disabled = true; b.textContent = '⏳ جارٍ التحديث…'; refreshing = true; load();
      };
      var ds = document.getElementById('dsel');
      if (ds) ds.onchange = function () {
        ds.disabled = true; toast('جارٍ تغيير التاريخ…');
        // لوحات الغياب كلها تتبع التاريخ نفسه (التقرير اليومي + اليوم + المعلمون اليوم)
        var ks = [key]; ['abs_daily', 'abs_today'].forEach(function (k) { if (k !== key && !(k === 'abs_today' && key === 'abs_teach') && hasView(k)) ks.push(k); });
        ks.reduce(function (p, k) { return p.then(function () { return api('setDate', { viewKey: k, date: ds.value }, 60000); }); }, Promise.resolve()).then(function () { load(); })
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
    // ---------- التواصل: واتساب ولي الأمر / بريد المعلم ----------
    function contactsOf(row) {
      var c = { wa: '', waLink: '', mailTo: '', mailCc: '', mailLink: '' };
      row.cells.forEach(function (x) {
        if (!x || typeof x !== 'object' || !x.l) return;
        var m = /wa\.me\/(\d+)/.exec(x.l); if (m) { c.wa = m[1]; c.waLink = x.l; }
        if (/mail\.google\.com|^mailto:/.test(x.l)) {
          c.mailLink = x.l;
          try { var q = new URL(x.l).searchParams; c.mailTo = q.get('to') || ''; c.mailCc = q.get('cc') || ''; } catch (e) {}
        }
      });
      return c;
    }
    function colVal(sec, row, re) {
      for (var i = 0; i < sec.header.length; i++) if (re.test(txt(sec.header[i].t))) return txt(row.cells[i]);
      return '';
    }
    function clean(d) { return String(d || '').replace(/^[^\u0600-\u06FFA-Za-z0-9]+/, '').trim(); }
    function decisionMessages(sec, row, values) {
      var dec = '', note = '';
      Object.keys(values).forEach(function (k) {
        if (/القرار ▼|قرار الموجه|③ القرار/.test(k)) dec = values[k];
        if (/ملاحظ/.test(k)) note = values[k];
      });
      if (!dec) return null;
      var c = contactsOf(row), out = { wa: '', mail: '' };
      var sign = key === 'tch_viol' ? 'وكالة شؤون المعلمين' : 'وكالة شؤون الطلاب';
      sign += ' – مدارس الأمجاد العالمية (قسم البنين)';
      if (c.wa && key !== 'tch_viol') {
        var st = colVal(sec, row, /^الطالب$/), cl = colVal(sec, row, /^الصف$/);
        var t = 'السلام عليكم ورحمة الله وبركاته\nولي أمر الطالب/ ' + st + (cl ? ' (' + cl + ')' : '') +
          '\nنفيدكم بأنه تم اتخاذ الإجراء التالي بخصوص ابنكم: «' + clean(dec) + '»';
        if (note) t += '\nملاحظة: ' + note;
        if (/استدعاء/.test(dec)) t += '\nنأمل التكرم بالحضور إلى المدرسة في أقرب وقت لمقابلة وكيل شؤون الطلاب.';
        else if (/إحالة/.test(dec)) t += '\nسيتواصل معكم الموجه الطلابي لمتابعة الحالة.';
        t += '\nشاكرين تعاونكم\n' + sign;
        out.wa = 'https://wa.me/' + c.wa + '?text=' + encodeURIComponent(t);
      }
      if (c.mailTo && key === 'tch_viol') {
        var tch = colVal(sec, row, /^المعلم$/), no = colVal(sec, row, /^رقم$/);
        var body = 'المكرم الأستاذ/ ' + tch + '   المحترم\nالسلام عليكم ورحمة الله وبركاته،\n\n' +
          'بالإشارة إلى المساءلة الإدارية رقم ' + no + '، نفيدكم بأن الإدارة قررت ما يلي: «' + clean(dec) + '»' +
          (note ? '\nملاحظة: ' + note : '') + '\n\nشاكرين تعاونكم،\n' + sign;
        out.mail = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(c.mailTo) +
          (c.mailCc ? '&cc=' + encodeURIComponent(c.mailCc) : '') +
          '&su=' + encodeURIComponent('قرار بشأن المساءلة رقم ' + no + ' – الأستاذ ' + tch) + '&body=' + encodeURIComponent(body);
      }
      return (out.wa || out.mail) ? out : null;
    }
    function contactBar(row) {
      var c = contactsOf(row), b = '';
      if (c.waLink) b += '<a class="btn small wa" href="' + esc(c.waLink) + '" target="_blank" rel="noopener">📲 واتساب ولي الأمر</a>';
      if (c.mailLink) b += '<a class="btn small ghost" href="' + esc(c.mailLink) + '" target="_blank" rel="noopener">📧 إرسال المساءلة للمعلم</a>';
      return b ? '<div class="contactbar"><span class="muted small">تواصل:</span>' + b + '</div>' : '';
    }
    function followUp(msgs) {
      var ov = document.createElement('div'); ov.className = 'overlay';
      ov.innerHTML = '<div class="sheetbox" role="dialog" aria-modal="true"><div class="sheethead"><b>✓ تم حفظ القرار</b><button class="x" id="fcl" aria-label="إغلاق">✕</button></div>' +
        '<div class="sheetbody"><p>هل تريد إبلاغ ' + (msgs.mail ? 'المعلم' : 'ولي الأمر') + ' بالقرار الآن؟ تُفتح الرسالة جاهزة، وتراجعها ثم تضغط إرسال.</p>' +
        (msgs.wa ? '<a class="btn wa" href="' + esc(msgs.wa) + '" target="_blank" rel="noopener">📲 إرسال القرار لولي الأمر (واتساب)</a>' : '') +
        (msgs.mail ? '<a class="btn" href="' + esc(msgs.mail) + '" target="_blank" rel="noopener">📧 إرسال القرار للمعلم (بريد)</a>' : '') +
        '</div><div class="actions"><button class="btn ghost" id="fln">لاحقاً</button></div></div>';
      document.body.appendChild(ov);
      var close = function () { ov.remove(); };
      ov.onclick = function (e) { if (e.target === ov) close(); };
      document.getElementById('fcl').onclick = close; document.getElementById('fln').onclick = close;
      Array.prototype.forEach.call(ov.querySelectorAll('a.btn'), function (a) { a.addEventListener('click', function () { setTimeout(close, 300); }); });
    }

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
        '<div class="sheetbody">' + contactBar(row) + '<div class="kvs">' + info + '</div>' + fields +
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
          var msgs = decisionMessages(sec, row, values); if (msgs) followUp(msgs);
        }).catch(function (e) {
          if (e.auth) { close(); return logout(true); }
          sv.disabled = false; sv.textContent = 'حفظ ✓';
          document.getElementById('eerr').innerHTML = '<div class="err">' + esc(e.net ? 'تعذر الاتصال، حاول مرة أخرى' : e.message) + '</div>';
        });
      };
    }
    function load() {
      if (!V) h(back + '<div class="loading">جارٍ تحميل «' + esc(meta.title) + '»…</div>');
      api('view', { viewKey: key }).then(function (j) {
        draw(j.view);
        if (refreshing) { refreshing = false; toast('✓ تم التحديث – ' + fmtTime(j.view.updatedAt)); }
      })
        .catch(function (e) {
          if (e.auth) return logout(true);
          h(back + '<div class="err">' + esc(e.net ? 'تعذر الاتصال بالإنترنت' : e.message) + '</div><button class="btn" id="r">إعادة المحاولة</button>');
          document.getElementById('r').onclick = load;
        });
    }
    load();
  }

  // ---------- الزيارات الصفية وتقييم أداء المعلمين ----------
  var VS = { month: '', data: null };
  function visCss() {
    if (document.getElementById('visCss')) return;
    var st = document.createElement('style'); st.id = 'visCss';
    st.textContent = '.vday{margin:14px 0 6px;font-weight:800;color:var(--blue-d)}.vday.today{color:var(--green-d)}' +
      '.vcard{background:#fff;border:1px solid var(--line);border-right:5px solid var(--blue);border-radius:12px;padding:10px 12px;margin:6px 0}' +
      '.vcard.done{border-right-color:var(--green)}.vcard.draft{border-right-color:#e6a817}' +
      '.vrow{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.vt{font-weight:800}.vm{color:var(--muted);font-size:14px}' +
      '.vbtns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}' +
      '.vtabs{display:flex;gap:6px;margin:10px 0}.vtabs .btn{flex:1}' +
      '.vdom{margin:16px 0 6px;padding:6px 10px;background:var(--green-l);border-radius:8px;font-weight:800;color:#3d6b22;display:flex;justify-content:space-between}' +
      '.vitem{padding:8px 2px 10px;border-bottom:1px solid #eef2f4}.vitem .q{font-weight:700;margin-bottom:6px;font-size:15.5px}' +
      '.vsc{display:grid;grid-template-columns:repeat(6,1fr);gap:5px}' +
      '.vsc button{border:1.5px solid var(--line);background:#fff;border-radius:9px;padding:8px 0 6px;font:inherit;font-weight:800;font-size:16px;color:var(--ink);cursor:pointer;line-height:1.1}' +
      '.vsc button small{display:block;font-size:10.5px;font-weight:600;color:var(--muted)}' +
      '.vsc button.on{color:#fff}.vsc button.on small{color:#fff}.vsc .s5.on{background:#2e8b57;border-color:#2e8b57}.vsc .s4.on{background:#8DB56B;border-color:#8DB56B}' +
      '.vsc .s3.on{background:#1A9BD7;border-color:#1A9BD7}.vsc .s2.on{background:#e67e22;border-color:#e67e22}.vsc .s1.on{background:#c0392b;border-color:#c0392b}.vsc .s0.on{background:#7f8c8d;border-color:#7f8c8d}' +
      '.vscore{position:sticky;top:84px;z-index:3;background:var(--blue);color:#fff;border-radius:12px;padding:9px 12px;font-weight:800;text-align:center;margin:8px 0;box-shadow:0 2px 6px rgba(0,0,0,.12)}' +
      '.vsum td,.vsum th{padding:7px 6px;border-bottom:1px solid #eef2f4;text-align:right;font-size:15px}.vsum{width:100%;border-collapse:collapse}' +
      '.vbox{background:#fff;border:1.5px dashed var(--blue);border-radius:12px;padding:12px;margin:8px 0}' +
      '.wsc{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.wsc button{border:1.5px solid var(--line);background:#fff;border-radius:9px;padding:9px 2px;font:inherit;font-weight:800;font-size:14px;cursor:pointer;color:var(--ink)}' +
      '.wsc .k2.on{background:#2e8b57;border-color:#2e8b57;color:#fff}.wsc .k1.on{background:#e6a817;border-color:#e6a817;color:#fff}.wsc .k0.on{background:#c0392b;border-color:#c0392b;color:#fff}' +
      '.wles{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}.wles .btn{font-size:13px;padding:7px 10px}details.wp{margin:6px 0}details.wp summary{font-weight:800;cursor:pointer;padding:6px 0;color:var(--blue-d)}';
    document.head.appendChild(st);
  }
  function visPct(scores) {
    var s = 0, n = 0; Object.keys(scores || {}).forEach(function (k) { var v = +scores[k]; if (v >= 1 && v <= 5) { s += v; n++; } });
    var p = n ? Math.round(s * 1000 / (n * 5)) / 10 : '';
    return { pct: p, n: n, grade: p === '' ? '' : p >= 90 ? 'A – ممتاز' : p >= 80 ? 'B – جيد جداً' : p >= 70 ? 'C – جيد' : p >= 60 ? 'D – مقبول' : 'يحتاج خطة تطوير' };
  }
  function visChip(v) {
    var k = /أُرسلت/.test(v.st) ? 'ok' : /معتمدة/.test(v.st) ? 'ok' : /مسودة/.test(v.st) ? 'warn' : '';
    return '<span class="chip ' + k + '">' + esc(v.st || 'مجدولة') + (v.pct !== '' && v.pct != null && v.st !== 'مجدولة' ? ' · ' + v.pct + '%' : '') + '</span>';
  }
  function viewVisits(id) {
    visCss();
    if (id) return viewVisitEval(id);
    var month = VS.month || todayISO().slice(0, 7), tab = 'agenda';
    h('<button class="back" onclick="location.hash=\'#/home\'">→ الرئيسية</button><h1>🗓️ الزيارات الصفية وتقييم الأداء</h1>' +
      '<div class="card"><label class="q">الشهر</label><input type="month" id="vm" value="' + month + '">' +
      '<div class="vbtns"><button class="btn" id="vplan">⚙️ إنشاء أجندة الشهر</button><button class="btn ghost" id="vadd">➕ زيارة جديدة</button></div>' +
      '<p class="help" style="margin:8px 0 0">الأجندة تضع زيارة رسمية واحدة لكل معلم في الشهر: زيارتان كحد أقصى في اليوم، بدون الحصة الأولى والأخيرة، وبعد أسبوع على الأقل. يُبلَّغ المعلم بالبريد تلقائياً قبل الزيارة بأسبوع.</p></div>' +
      '<div id="vform"></div><div id="vkpi"></div><div class="vtabs"><button class="btn small" id="t1">الأجندة</button><button class="btn small ghost" id="t2">ملخص المعلمين</button><button class="btn small ghost" id="t3">🚶 الجولة اليومية</button></div><div id="vlist"><div class="loading">جارٍ التحميل…</div></div>');
    var $l = document.getElementById('vlist');
    function load() {
      $l.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
      api('visList', { month: month }).then(function (j) { VS.month = month; VS.data = j; draw(); })
        .catch(function (e) { if (e.auth) return logout(true); $l.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
    }
    function draw() {
      var j = VS.data, c = { 'مجدولة': 0, 'مسودة': 0, 'معتمدة': 0, 'أُرسلت': 0 };
      j.visits.forEach(function (v) { c[v.st] = (c[v.st] || 0) + 1; });
      document.getElementById('vkpi').innerHTML = '<div class="kpis">' + Object.keys(c).map(function (k) { return '<div class="kpi"><b>' + c[k] + '</b><span>' + k + '</span></div>'; }).join('') + '</div>';
      document.getElementById('t1').className = 'btn small' + (tab === 'agenda' ? '' : ' ghost');
      document.getElementById('t2').className = 'btn small' + (tab === 'sum' ? '' : ' ghost');
      document.getElementById('t3').className = 'btn small' + (tab === 'walk' ? '' : ' ghost');
      if (tab === 'walk') return walkView();
      if (tab === 'sum') {
        $l.innerHTML = '<div class="card"><table class="vsum"><tr><th>المعلم</th><th>زيارات معتمدة</th><th>آخر نسبة</th><th>المتوسط</th></tr>' +
          j.summary.sort(function (a, b) { return (a.avg === '' ? 999 : a.avg) - (b.avg === '' ? 999 : b.avg); }).map(function (s) {
            return '<tr><td>' + esc(s.t) + '</td><td>' + s.n + '</td><td>' + (s.last === '' ? '—' : s.last + '%') + '</td><td>' + (s.avg === '' ? '—' : '<b>' + s.avg + '%</b>') + '</td></tr>';
          }).join('') + '</table><p class="help">مرتب من الأقل متوسطاً، ليبدأ الدعم بمن يحتاجه أكثر.</p></div>';
        return;
      }
      if (!j.visits.length) { $l.innerHTML = '<div class="warnbox">لا توجد زيارات في هذا الشهر. اضغط «إنشاء أجندة الشهر».</div>'; return; }
      var html = '', last = '', td = todayISO().replace(/-/g, '/');
      j.visits.forEach(function (v) {
        if (v.date !== last) { last = v.date; html += '<div class="vday' + (v.date === td ? ' today' : '') + '">' + esc(v.day + ' ' + v.date) + (v.date === td ? ' — اليوم' : '') + '</div>'; }
        var fin = /معتمدة|أُرسلت/.test(v.st);
        html += '<div class="vcard ' + (fin ? 'done' : v.st === 'مسودة' ? 'draft' : '') + '"><div class="vrow"><div><div class="vt">الحصة ' + v.p + ' · ' + esc(v.c) + ' · أ. ' + esc(v.t) + '</div>' +
          '<div class="vm">' + esc(v.s) + (v.by ? ' · الزائر: ' + esc(v.by) : '') + '</div>' +
          (v.notified ? '<div class="vm">📧 أُبلغ المعلم: ' + esc(String(v.notified).split(' → ')[0]) + '</div>' : (v.st === 'مجدولة' ? '<div class="vm">⏳ يُبلَّغ المعلم بالبريد قبل الزيارة بأسبوع</div>' : '')) + '</div>' + visChip(v) + '</div><div class="vbtns">' +
          '<a class="btn small' + (fin ? ' ghost' : '') + '" href="#/visits/' + esc(v.id) + '">' + (fin ? '📄 التقرير' : v.st === 'مسودة' ? '📝 إكمال التقييم' : '📝 بدء التقييم') + '</a>' +
          (fin ? '' : '<button class="btn small ghost" data-mv="' + esc(v.id) + '">↔ نقل</button><button class="btn small ghost" data-del="' + esc(v.id) + '">🗑 حذف</button>') + '</div></div>';
      });
      $l.innerHTML = html;
      $l.querySelectorAll('[data-mv]').forEach(function (b) { b.onclick = function () { var v = j.visits.filter(function (x) { return x.id === b.dataset.mv; })[0]; slotForm(v); }; });
      $l.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () {
          var v = j.visits.filter(function (x) { return x.id === b.dataset.del; })[0];
          if (!confirm('حذف زيارة أ. ' + v.t + ' يوم ' + v.date + '؟')) return;
          api('visDel', { id: v.id }).then(function () { toast('تم الحذف'); load(); }).catch(function (e) { toast(e.message); });
        };
      });
    }
    // نموذج إضافة زيارة أو نقلها: المعلم + التاريخ + حصته في ذلك اليوم
    function slotForm(v) {
      var $f = document.getElementById('vform'), teachers = (VS.data && VS.data.summary || []).map(function (s) { return s.t; }).sort(function (a, b) { return a.localeCompare(b); });
      var minD = (VS.data && VS.data.minDate) || todayISO(), d0 = v ? v.date.replace(/\//g, '-') : minD;
      $f.innerHTML = '<div class="vbox"><b>' + (v ? '↔ نقل زيارة أ. ' + esc(v.t) : '➕ زيارة جديدة') + '</b>' +
        (v ? '' : '<label class="q">المعلم</label><select id="ft"><option value="">— اختر —</option>' + teachers.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('') + '</select>') +
        '<label class="q">التاريخ <small class="vm">(أقرب موعد ' + esc(minD) + ' لإبلاغ المعلم قبل أسبوع)</small></label><input type="date" id="fd" min="' + minD + '" value="' + d0 + '"><label class="q">الحصة</label><select id="fp"><option value="">— اختر المعلم والتاريخ —</option></select>' +
        '<div class="vbtns"><button class="btn green" id="fok">حفظ</button><button class="btn ghost" id="fx">إلغاء</button></div></div>';
      window.scrollTo(0, 0);
      var who = function () { return v ? v.t : document.getElementById('ft').value; };
      var slots = function () {
        var t = who(), d = document.getElementById('fd').value, $p = document.getElementById('fp');
        if (!t || !d) return;
        $p.innerHTML = '<option value="">جارٍ التحميل…</option>';
        api('visSlots', { t: t, date: d, id: v ? v.id : '' }).then(function (j) {
          if (j.holiday) { $p.innerHTML = '<option value="">' + esc(j.day) + ' إجازة</option>'; return; }
          if (j.early) { $p.innerHTML = '<option value="">أقرب موعد ' + esc(j.minDate) + ' (إبلاغ قبل أسبوع)</option>'; return; }
          if (j.full) { $p.innerHTML = '<option value="">اكتمل الحد: زيارتان في هذا اليوم</option>'; return; }
          $p.innerHTML = j.lessons.length ? '<option value="">— اختر —</option>' + j.lessons.map(function (l) {
            if (l.no) return '<option value="" disabled>الحصة ' + l.p + ' – ' + esc(l.c) + ' (الأولى/الأخيرة لا تُزار)</option>';
            return '<option value="' + l.p + '"' + (v && v.p === l.p && v.date.replace(/\//g, '-') === d ? ' selected' : '') + '>الحصة ' + l.p + ' – ' + esc(l.c) + ' – ' + esc(l.s) + (l.busy ? ' (فيها زيارة لـ ' + esc(l.busy) + ')' : '') + '</option>';
          }).join('') : '<option value="">لا حصص له يوم ' + esc(j.day) + '</option>';
        }).catch(function (e) { $p.innerHTML = '<option value="">' + esc(e.message) + '</option>'; });
      };
      if (!v) document.getElementById('ft').onchange = slots;
      document.getElementById('fd').onchange = slots; slots();
      document.getElementById('fx').onclick = function () { $f.innerHTML = ''; };
      document.getElementById('fok').onclick = function () {
        var t = who(), d = document.getElementById('fd').value, p = document.getElementById('fp').value;
        if (!t || !d || !p) return toast('اختر المعلم والتاريخ والحصة');
        this.disabled = true;
        api(v ? 'visMove' : 'visAdd', v ? { id: v.id, date: d, p: p } : { t: t, date: d, p: p }).then(function () {
          $f.innerHTML = ''; toast('تم الحفظ ✓'); var mo = d.slice(0, 7); if (mo !== month) { month = mo; document.getElementById('vm').value = mo; } load();
        }).catch(function (e) { toast(e.message); document.getElementById('fok').disabled = false; });
      };
    }
    document.getElementById('vm').onchange = function () { month = this.value || month; load(); };
    document.getElementById('t1').onclick = function () { tab = 'agenda'; if (VS.data) draw(); };
    document.getElementById('t2').onclick = function () { tab = 'sum'; if (VS.data) draw(); };
    document.getElementById('t3').onclick = function () { tab = 'walk'; if (VS.data) draw(); };
    // الجولة اليومية: زيارات تجوالية قصيرة بدون إبلاغ مسبق
    var WK = { date: todayISO(), data: null };
    function walkView() {
      $l.innerHTML = '<div class="card"><label class="q">تاريخ الجولة</label><input type="date" id="wd" value="' + WK.date + '">' +
        '<p class="help" style="margin:6px 0 0">جولة قصيرة (5–10 دقائق) بدون إبلاغ مسبق. اختر من المقترح أو من حصص اليوم، وقيّم 6 بنود سريعة.</p></div><div id="wform"></div><div id="wbody"><div class="loading">جارٍ التحميل…</div></div>';
      document.getElementById('wd').onchange = function () { WK.date = this.value || WK.date; walkLoad(); };
      walkLoad();
    }
    function walkLoad() {
      var $b = document.getElementById('wbody'); if (!$b) return;
      $b.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
      api('visWalk', { date: WK.date }).then(function (j) { WK.data = j; walkDraw(); })
        .catch(function (e) { if (e.auth) return logout(true); $b.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
    }
    function walkDraw() {
      var j = WK.data, $b = document.getElementById('wbody'); if (!$b) return;
      if (j.holiday) { $b.innerHTML = '<div class="warnbox">' + esc(j.day) + ' إجازة أو عطلة نهاية الأسبوع.</div>'; return; }
      var lbtn = function (x) { return '<button class="btn small ghost" data-wp="' + x.p + '" data-wt="' + esc(x.t) + '">ح' + x.p + ' · ' + esc(x.c) + ' · ' + esc(x.t) + '</button>'; };
      var html = '';
      html += '<div class="card"><b>🎯 مقترح جولة ' + esc(j.day) + '</b> <small class="vm">(الأقل زيارة تجوالية مؤخراً)</small><div class="wles">' +
        (j.suggest.length ? j.suggest.map(lbtn).join('') : '<span class="vm">لا مقترحات</span>') + '</div>';
      var byP = {}; j.lessons.forEach(function (x) { (byP[x.p] = byP[x.p] || []).push(x); });
      html += Object.keys(byP).sort(function (a, b) { return a - b; }).map(function (p) {
        return '<details class="wp"><summary>الحصة ' + p + ' (' + byP[p].length + ')</summary><div class="wles">' + byP[p].map(lbtn).join('') + '</div></details>';
      }).join('') + '</div>';
      html += '<h3>✅ جولات ' + esc(j.day + ' ' + j.date) + ' (' + j.done.length + ')</h3>';
      html += j.done.length ? j.done.map(function (o) {
        return '<div class="vcard done"><div class="vrow"><div><div class="vt">الحصة ' + o.p + ' · ' + esc(o.c) + ' · أ. ' + esc(o.t) + '</div><div class="vm">' + esc(o.s) + (o.by ? ' · ' + esc(o.by) : '') + '</div>' +
          (o.str ? '<div class="vm">📝 ' + esc(o.str) + '</div>' : '') + (o.mailed ? '<div class="vm">📧 أُرسلت للمعلم</div>' : '') + '</div><span class="chip ok">' + o.pct + '%</span></div>' +
          '<div class="vbtns"><button class="btn small ghost" data-we="' + esc(o.id) + '">✏️ تعديل</button>' + (o.mailed ? '' : '<button class="btn small" data-wm="' + esc(o.id) + '">📧 إرسال الملاحظات للمعلم</button>') +
          '<button class="btn small ghost" data-wx="' + esc(o.id) + '">🗑</button></div></div>';
      }).join('') : '<p class="vm">لا توجد جولات مسجلة في هذا اليوم.</p>';
      $b.innerHTML = html;
      $b.querySelectorAll('[data-wp]').forEach(function (b) { b.onclick = function () { walkForm({ p: +b.dataset.wp, t: b.dataset.wt }); }; });
      $b.querySelectorAll('[data-we]').forEach(function (b) { b.onclick = function () { walkForm(j.done.filter(function (o) { return o.id === b.dataset.we; })[0]); }; });
      $b.querySelectorAll('[data-wx]').forEach(function (b) { b.onclick = function () { if (!confirm('حذف هذه الجولة؟')) return; api('visDel', { id: b.dataset.wx }).then(function () { toast('تم الحذف'); walkLoad(); }).catch(function (e) { toast(e.message); }); }; });
      $b.querySelectorAll('[data-wm]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('إرسال ملاحظات الجولة إلى بريد المعلم؟')) return; b.disabled = true;
          api('visWalkMail', { id: b.dataset.wm }, 60000).then(function (r) { toast('أُرسلت إلى ' + r.to + ' ✓', 4000); walkLoad(); }).catch(function (e) { b.disabled = false; toast(e.message, 5000); });
        };
      });
    }
    function walkForm(o) {
      var j = WK.data, L = j.lessons.filter(function (x) { return x.p === o.p && x.t === o.t; })[0] || o, sc = Object.assign({}, o.scores || {});
      var $f = document.getElementById('wform');
      $f.innerHTML = '<div class="vbox"><b>🚶 جولة: الحصة ' + L.p + ' · ' + esc(L.c || '') + ' · أ. ' + esc(L.t) + '</b><div class="vm">' + esc(L.s || '') + '</div>' +
        j.items.map(function (w) {
          return '<div class="vitem"><div class="q">' + esc(w[1]) + '</div><div class="wsc" data-w="' + w[0] + '">' +
            [[2, '✔ متحقق'], [1, '◐ جزئياً'], [0, '✘ غير متحقق']].map(function (k) { return '<button type="button" class="k' + k[0] + (sc[w[0]] === k[0] ? ' on' : '') + '" data-k="' + k[0] + '">' + k[1] + '</button>'; }).join('') + '</div></div>';
        }).join('') +
        '<label class="q">ملاحظة سريعة</label><textarea id="wnote" style="min-height:60px">' + esc(o.str || '') + '</textarea>' +
        '<div class="vbtns"><button class="btn green" id="wok">💾 حفظ الجولة</button><button class="btn ghost" id="wx">إلغاء</button></div></div>';
      $f.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $f.querySelectorAll('.wsc button').forEach(function (b) {
        b.onclick = function () { var w = b.parentNode.dataset.w, k = +b.dataset.k; if (sc[w] === k) delete sc[w]; else sc[w] = k;
          b.parentNode.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', sc[w] === +x.dataset.k); }); };
      });
      document.getElementById('wx').onclick = function () { $f.innerHTML = ''; };
      document.getElementById('wok').onclick = function () {
        if (!Object.keys(sc).length) return toast('قيّم بنداً واحداً على الأقل');
        var b = this; b.disabled = true;
        api('visWalkSave', o.id ? { id: o.id, scores: sc, note: document.getElementById('wnote').value } : { date: WK.date, t: L.t, p: L.p, scores: sc, note: document.getElementById('wnote').value })
          .then(function () { $f.innerHTML = ''; toast('تم حفظ الجولة ✓'); walkLoad(); })
          .catch(function (e) { b.disabled = false; toast(e.message, 5000); });
      };
    }

    document.getElementById('vadd').onclick = function () { slotForm(null); };
    document.getElementById('vplan').onclick = function () {
      var b = this; b.disabled = true; b.textContent = 'جارٍ إنشاء الأجندة…';
      api('visPlan', { month: month }, 60000).then(function (j) {
        toast(j.msg || ('أُضيفت ' + j.added + ' زيارة' + (j.missed && j.missed.length ? ' — تعذّر جدولة: ' + j.missed.join('، ') : '')), 5000);
        b.disabled = false; b.textContent = '⚙️ إنشاء أجندة الشهر'; load();
      }).catch(function (e) { toast(e.message, 5000); b.disabled = false; b.textContent = '⚙️ إنشاء أجندة الشهر'; });
    };
    load();
  }

  function viewVisitEval(id) {
    h('<button class="back" onclick="location.hash=\'#/visits\'">→ الأجندة</button><div class="loading">جارٍ التحميل…</div>');
    var go = function (j) {
      var v = j.visits.filter(function (x) { return x.id === id; })[0];
      if (!v) { h('<button class="back" onclick="location.hash=\'#/visits\'">→ الأجندة</button><div class="err">الزيارة غير موجودة في هذا الشهر.</div>'); return; }
      renderEval(v, j);
    };
    if (VS.data && VS.data.visits.some(function (x) { return x.id === id; })) return go(VS.data);
    api('visList', { month: VS.month || todayISO().slice(0, 7) }).then(function (j) { VS.data = j; VS.month = j.month; go(j); })
      .catch(function (e) { if (e.auth) return logout(true); h('<div class="err">' + esc(e.message) + '</div>'); });
  }

  function renderEval(v, j) {
    var key = 'vis_' + v.id, loc = get(key, null);
    var E = loc && loc.scores ? loc : { scores: v.scores || {}, topic: v.topic || '', str: v.str || '', imp: v.imp || '', rec: v.rec || '' };
    var fin = /معتمدة|أُرسلت/.test(v.st), sent = /أُرسلت/.test(v.st);
    var save = function () { E.at = new Date().toISOString(); set(key, E); };
    var html = '<button class="back" onclick="location.hash=\'#/visits\'">→ الأجندة</button><h1>📝 تقييم زيارة صفية</h1>' +
      '<div class="card"><div class="vt">أ. ' + esc(v.t) + ' — ' + esc(v.s) + '</div><div class="vm">' + esc(v.day + ' ' + v.date) + ' · الحصة ' + v.p + ' · ' + esc(v.c) + '</div>' +
      (v.mailed ? '<div class="vm">📧 أُرسل: ' + esc(v.mailed) + '</div>' : '') +
      '<label class="q">موضوع الدرس</label><input type="text" id="etopic" value="' + esc(E.topic) + '" placeholder="عنوان الدرس الذي حضرته"></div>' +
      '<div class="vscore" id="escore"></div>' +
      (fin ? '<div class="card" id="erep"><b>📄 التقرير جاهز</b><div class="vbtns"><a class="btn small" target="_blank" rel="noopener" href="' + esc(v.pdf) + '">فتح التقرير PDF</a>' +
        '<button class="btn small" id="email">📧 إرسال بالبريد للمعلم</button><a class="btn small wa" id="ewa" target="_blank" rel="noopener" href="#">📲 واتساب</a></div>' +
        '<p class="help" style="margin:6px 0 0">يمكنك تعديل التقييم وإعادة الاعتماد لإنشاء تقرير محدّث' + (sent ? ' (أُرسل سابقاً للمعلم)' : '') + '.</p></div>' : '');
    var lab = {}; j.scale.forEach(function (x) { lab[x[0]] = x[1]; });
    j.crit.forEach(function (g) {
      html += '<div class="vdom"><span>' + esc(g.d) + '</span><span class="vm">' + esc(g.k) + '</span></div>';
      g.items.forEach(function (it) {
        var cur = E.scores[it.id];
        html += '<div class="vitem"><div class="q">' + esc(it.t) + '</div><div class="vsc" data-it="' + it.id + '">' +
          [5, 4, 3, 2, 1, 0].map(function (n) {
            return '<button type="button" class="s' + n + (cur === n ? ' on' : '') + '" data-n="' + n + '">' + (n ? n : '—') + '<small>' + (n ? lab[n] : 'لا ينطبق') + '</small></button>';
          }).join('') + '</div></div>';
      });
    });
    html += '<div class="card"><button class="btn ghost small" id="esug" style="width:100%">✨ اقتراح الملاحظات والتوصيات من التقييم</button>' +
      '<label class="q">✔ نقاط القوة</label><textarea id="estr" placeholder="كل ملاحظة في سطر">' + esc(E.str) + '</textarea>' +
      '<label class="q">● ما لوحظ ويحتاج تحسيناً</label><textarea id="eimp" placeholder="كل ملاحظة في سطر">' + esc(E.imp) + '</textarea>' +
      '<label class="q">➜ التوصيات وما يجب على المعلم فعله</label><textarea id="erec" placeholder="كل توصية في سطر">' + esc(E.rec) + '</textarea></div>' +
      '<div class="actions"><button class="btn ghost" id="edraft">💾 حفظ مسودة</button><button class="btn green" id="efin">✅ اعتماد وإنشاء التقرير</button></div>';
    h(html);
    var score = function () {
      var P = visPct(E.scores);
      document.getElementById('escore').textContent = P.n ? 'النسبة: ' + P.pct + '% — ' + P.grade + ' (' + P.n + ' بنداً)' : 'اختر مستوى كل بند أثناء الحصة';
    };
    score();
    $app.querySelectorAll('.vsc button').forEach(function (b) {
      b.onclick = function () {
        var it = b.parentNode.dataset.it, n = +b.dataset.n;
        if (E.scores[it] === n) delete E.scores[it]; else E.scores[it] = n;
        b.parentNode.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', E.scores[it] === +x.dataset.n); });
        save(); score();
      };
    });
    [['etopic', 'topic'], ['estr', 'str'], ['eimp', 'imp'], ['erec', 'rec']].forEach(function (p) {
      document.getElementById(p[0]).addEventListener('input', function () { E[p[1]] = this.value; save(); });
    });
    document.getElementById('esug').onclick = function () {
      var all = []; j.crit.forEach(function (g) { g.items.forEach(function (it) { all.push(it); }); });
      var sc = function (it) { return E.scores[it.id]; };
      var hi = all.filter(function (it) { return sc(it) === 5; });
      if (hi.length < 3) hi = hi.concat(all.filter(function (it) { return sc(it) === 4; })).slice(0, 5);
      var low = all.filter(function (it) { return sc(it) >= 1 && sc(it) <= 2; });
      var mid = all.filter(function (it) { return sc(it) === 3; });
      var recs = low.concat(mid).slice(0, 6);
      if (!hi.length && !recs.length) return toast('قيّم البنود أولاً ثم اضغط الاقتراح');
      if ((E.str || E.imp || E.rec) && !confirm('سيتم استبدال النصوص الحالية بالاقتراح. متابعة؟')) return;
      E.str = hi.map(function (it) { return it.s; }).join('\n');
      E.imp = low.map(function (it) { return it.t + ' (يحتاج تحسيناً)'; }).concat(mid.map(function (it) { return it.t + ' (متمكن ويمكن تطويره)'; })).join('\n');
      E.rec = recs.map(function (it) { return it.r; }).join('\n');
      document.getElementById('estr').value = E.str; document.getElementById('eimp').value = E.imp; document.getElementById('erec').value = E.rec;
      save(); toast('تمت تعبئة الاقتراح، عدّله بما لاحظته في الحصة');
    };
    var send = function (final) {
      var b = document.getElementById(final ? 'efin' : 'edraft'), t = b.textContent;
      b.disabled = true; b.textContent = final ? 'جارٍ إنشاء التقرير…' : 'جارٍ الحفظ…';
      api('visSave', { id: v.id, scores: E.scores, topic: E.topic, str: E.str, imp: E.imp, rec: E.rec, final: !!final }, 90000).then(function (r) {
        del(key);
        var i = VS.data.visits.map(function (x) { return x.id; }).indexOf(v.id); if (i >= 0) VS.data.visits[i] = r.visit;
        toast(final ? 'تم اعتماد التقييم وإنشاء التقرير ✓' : 'تم حفظ المسودة ✓');
        renderEval(r.visit, VS.data);
      }).catch(function (e) { b.disabled = false; b.textContent = t; if (e.auth) return logout(true); toast(e.message, 5000); });
    };
    document.getElementById('edraft').onclick = function () { send(false); };
    document.getElementById('efin').onclick = function () {
      if (visPct(E.scores).n < 10) return toast('قيّم 10 بنود على الأقل قبل الاعتماد');
      if (!String(E.rec || '').trim()) return toast('اكتب التوصيات وما يجب على المعلم فعله');
      send(true);
    };
    if (fin) {
      var wa = document.getElementById('ewa');
      api('visWa', { id: v.id }).then(function (r) { wa.href = r.url; }).catch(function () { wa.style.display = 'none'; });
      document.getElementById('email').onclick = function () {
        var b = this; if (!confirm('إرسال التقرير إلى بريد أ. ' + v.t + '؟')) return;
        b.disabled = true; b.textContent = 'جارٍ الإرسال…';
        api('visMail', { id: v.id }, 60000).then(function (r) {
          toast('أُرسل التقرير إلى ' + r.to + ' ✓', 4000);
          var i = VS.data.visits.map(function (x) { return x.id; }).indexOf(v.id); if (i >= 0) VS.data.visits[i] = r.visit;
          renderEval(r.visit, VS.data);
        }).catch(function (e) { b.disabled = false; b.textContent = '📧 إرسال بالبريد للمعلم'; toast(e.message, 5000); });
      };
    }
  }

  // ---------- التوجيه ----------
  function route() {
    renderNetbar();
    document.body.classList.toggle('wide', /^#\/(view|report|subs)\b/.test(location.hash || ''));
    var hash = location.hash || '#/home';
    if (!state.token) { return viewLogin('email'); }
    var m = hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
    if (m[1] === 'form' && m[2]) {
      if (!(state.menu.forms || []).some(function (f) { return f.key === m[2]; })) { location.hash = '#/home'; return; }
      return viewForm(m[2]);
    }
    if (m[1] === 'view' && m[2]) return viewSheet(m[2]);
    if (m[1] === 'outbox') return viewOutbox();
    if (m[1] === 'report') return viewReport();
    if (m[1] === 'subs') return viewSubs();
    if (m[1] === 'visits') return viewVisits(m[2]);
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
  // تحديث تلقائي: عند نشر نسخة جديدة يُعاد تحميل التطبيق (إلا أثناء تعبئة نموذج فيُؤجَّل للعودة للرئيسية)
  if ('serviceWorker' in navigator) {
    var hadCtl = !!navigator.serviceWorker.controller, pendingReload = false;
    var doReload = function () { if (/^#\/form\//.test(location.hash || '') || state.sending) { pendingReload = true; return; } location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadCtl) doReload(); hadCtl = true; });
    window.addEventListener('hashchange', function () { if (pendingReload && !/^#\/form\//.test(location.hash || '')) location.reload(); });
    var checkUpd = function () { navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {}); };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkUpd(); });
    setInterval(checkUpd, 10 * 60 * 1000);
  }

  route(); refreshMe(); flushOutbox();
  window.__amjad = { state: state, outbox: outbox, flushOutbox: flushOutbox }; // للاختبار
})();
