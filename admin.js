/* AKUN availability — editor.
   Login: email + password checked against data/auth.json (PBKDF2 verifier).
   The GitHub token is stored in auth.json encrypted (AES-GCM) with each user's password,
   so once one person connects GitHub, every user can log in from any device and save.
   Saves go to GitHub → the site redeploys → every visitor sees the change. */
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const DOWS = ['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'];
  const DOW_FULL = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const DOW_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const ss = { get: k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
               set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const st = { mode: 'github', auth: null, authSha: null, user: null, conn: null, ok: false,
               reg: null, regSha: null, resort: null, month: null, base: null, edits: null, saved: '', sha: null };

  let tt; function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 5000); }

  /* ================= crypto ================= */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
  const b64 = b => { let s = ''; new Uint8Array(b).forEach(x => s += String.fromCharCode(x)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function derive(pw, saltHex, iter) {
    const km = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const dk = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, km, 512));
    const key = await crypto.subtle.importKey('raw', dk.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, verifier: hex(dk.slice(32)) };
  }
  async function encryptToken(key, token) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv: hex(iv), ct: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token))) };
  }
  const decryptToken = async (key, t) => dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(t.iv) }, key, unb64(t.ct)));
  async function newUser(email, pw, token, role) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16))), d = await derive(pw, salt, st.auth.iterations);
    return { email: email.toLowerCase(), role: role || 'editor', salt, verifier: d.verifier, token: token ? await encryptToken(d.key, token) : null };
  }

  /* ================= GitHub API ================= */
  const b64dec = b => dec.decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0)));
  const b64enc = s => b64(enc.encode(s));
  const gh = (path, opt = {}) => fetch('https://api.github.com' + path, Object.assign({}, opt, { headers: Object.assign({
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${st.conn.token}`, 'X-GitHub-Api-Version': '2022-11-28' }, opt.headers || {}) }));
  async function ghGet(path) {
    const r = await gh(`/repos/${st.conn.repo}/contents/${path}?ref=${encodeURIComponent(st.conn.branch)}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub ' + r.status);
    const j = await r.json(); return { json: JSON.parse(b64dec(j.content)), sha: j.sha };
  }
  async function ghPut(path, obj, sha, message) {
    const body = { message, content: b64enc(JSON.stringify(obj, null, 1) + '\n'), branch: st.conn.branch };
    if (sha) body.sha = sha;
    const r = await gh(`/repos/${st.conn.repo}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
    return (await r.json()).content.sha;
  }
  async function dispatch(month, force, resort) {
    const r = await gh(`/repos/${st.conn.repo}/actions/workflows/site.yml/dispatches`, { method: 'POST',
      body: JSON.stringify({ ref: st.conn.branch, inputs: { month: month || '', force: force ? 'true' : 'false', resort: resort || '' } }) }).catch(() => null);
    return r && r.status === 204;
  }
  async function load(path) {   // fresh from GitHub when connected, else the published copy
    if (st.ok && st.mode === 'github') { try { return await ghGet(path); } catch {} }
    const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) return null; return { json: await r.json(), sha: null };
  }
  async function testConn(c) {
    const r = await fetch(`https://api.github.com/repos/${c.repo}`, { headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json' } });
    if (r.status === 401) throw new Error('مفتاح الوصول غير صالح');
    if (r.status === 404) throw new Error('المستودع غير موجود أو المفتاح لا يملك صلاحية عليه');
    if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} throw new Error('GitHub ' + r.status + (m ? ' — ' + m : '')); }
    const j = await r.json(); if (j.permissions && !j.permissions.push) throw new Error('المفتاح لا يملك صلاحية الكتابة — عدّل المفتاح وأضف Contents: Read and write');
  }
  function guessRepo() {
    const h = location.hostname; if (!h.endsWith('.github.io')) return '';
    const owner = h.split('.')[0], seg = location.pathname.split('/').filter(Boolean)[0];
    return `${owner}/${seg && !seg.endsWith('.html') ? seg : owner + '.github.io'}`;
  }
  async function saveAuth(msg) {
    if (st.mode === 'cloud') { await AKUN.cloudSet('config/auth', st.auth); return; }
    const cur = await ghGet('data/auth.json'); st.authSha = cur ? cur.sha : null;
    st.authSha = await ghPut('data/auth.json', st.auth, st.authSha, msg);
  }

  async function loadAuth() {
    if (st.mode === 'cloud') { const c = await AKUN.cloudGet('config/auth'); if (c && c.users) return c; }
    const r = await fetch('data/auth.json', { cache: 'no-store' }); return r.ok ? r.json() : null;
  }

  /* ================= login flow ================= */
  const show = id => ['#loginScreen', '#setupScreen', '#adminMain'].forEach(s => $(s).hidden = s !== id);
  let pending = null;   // { user, key } between login and first-time setup
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('#lEmail').value.trim().toLowerCase(), pw = $('#lPass').value;
    $('#loginBtn').disabled = true; $('#loginMsg').textContent = '…';
    try {
      st.auth = await loadAuth();
      const u = st.auth.users.find(x => x.email.toLowerCase() === email);
      const d = u ? await derive(pw, u.salt, st.auth.iterations) : null;
      if (!u || d.verifier !== u.verifier) throw new Error('الإيميل أو الرمز السري غير صحيح');
      if (st.mode === 'cloud') {
        st.user = u.email; ss.set('akun-session', { user: st.user, mode: 'cloud' });
        $('#lPass').value = ''; await enter();
      } else if (u.token) {
        const token = await decryptToken(d.key, u.token);
        st.conn = { repo: st.auth.repo || guessRepo(), branch: st.auth.branch || 'main', token };
        st.user = u.email; ss.set('akun-session', { user: st.user, conn: st.conn });
        $('#lPass').value = ''; await enter();
      } else {
        pending = { user: u, key: d.key };
        $('#sRepo').value = st.auth.repo || guessRepo(); $('#sBranch').value = st.auth.branch || 'main';
        show('#setupScreen'); $('#sToken').focus();
      }
    } catch (err) { $('#loginMsg').innerHTML = `<span class="err-txt">${esc(err.message)}</span>`; }
    finally { $('#loginBtn').disabled = false; }
  };
  $('#setupForm').onsubmit = async e => {
    e.preventDefault();
    const c = { repo: $('#sRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''), branch: $('#sBranch').value.trim() || 'main', token: $('#sToken').value.trim() };
    $('#setupBtn').disabled = true; $('#setupMsg').textContent = '…';
    try {
      await testConn(c);
      st.conn = c; st.ok = true;
      const fresh = await ghGet('data/auth.json'); if (fresh) st.auth = fresh.json;
      st.auth.repo = c.repo; st.auth.branch = c.branch;
      const u = st.auth.users.find(x => x.email === pending.user.email);
      u.token = await encryptToken(pending.key, c.token);
      await saveAuth('ربط لوحة التعديل بـ GitHub');
      st.user = u.email; ss.set('akun-session', { user: st.user, conn: st.conn }); pending = null;
      await enter();
    } catch (err) { st.ok = false; $('#setupMsg').innerHTML = `<span class="err-txt">${esc(err.message === 'Failed to fetch' ? 'تعذر الوصول إلى GitHub من هذه الصفحة' : err.message)}</span>`; }
    finally { $('#setupBtn').disabled = false; }
  };
  $('#logoutBtn').onclick = () => { if (dirty() && !confirmSafe('لديك تعديلات غير محفوظة. تسجيل الخروج؟')) return; ss.set('akun-session', null); location.reload(); };
  const confirmSafe = m => { try { return confirm(m); } catch { return true; } };

  async function enter() {
    if (!st.auth) st.auth = await loadAuth();
    if (st.mode === 'cloud') { st.ok = true; st.conn = { repo: '' }; $('#genBtn').hidden = true; }
    else try { await testConn(st.conn); st.ok = true; } catch (e) { st.ok = false; toast('تعذر الاتصال بـ GitHub: ' + (e.message === 'Failed to fetch' ? 'لا يمكن الوصول من هذه الصفحة' : e.message) + ' — يمكنك التصفح، لكن الحفظ لن يعمل', true); }
    $('#connPill').hidden = false; $('#connPill').textContent = (st.ok ? '● ' : '○ ') + st.user; $('#connPill').classList.toggle('ok', st.ok);
    $('#logoutBtn').hidden = false; $('#accSummary').textContent = st.mode === 'cloud' ? 'الحفظ مباشر في الموقع' : (st.conn.repo || '');
    show('#adminMain'); renderUsers(); await boot();
  }

  /* ================= account ================= */
  const me = () => st.auth.users.find(u => u.email === st.user);
  function renderUsers() {
    if (!st.auth) return;
    $('#userList').innerHTML = st.auth.users.map(u => `<div class="urow"><span dir="ltr">${esc(u.email)}</span>
      <span class="tag${u.role === 'owner' ? ' c' : ''}">${u.role === 'owner' ? 'أساسي' : 'محرر'}</span>
      ${u.email !== st.user && u.role !== 'owner' ? `<button class="btn danger" data-rm="${esc(u.email)}" type="button">حذف</button>` : ''}</div>`).join('');
    $('#userList').querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
      if (!confirmSafe(`حذف ${b.dataset.rm}؟`)) return;
      st.auth.users = st.auth.users.filter(u => u.email !== b.dataset.rm);
      try { await saveAuth(`حذف مستخدم ${b.dataset.rm}`); toast('تم حذف المستخدم ✓'); renderUsers(); } catch (e) { toast('تعذر الحفظ: ' + e.message, true); }
    });
  }
  $('#pwForm').onsubmit = async e => {
    e.preventDefault();
    if ($('#pwNew').value !== $('#pwNew2').value) return toast('الرمزان الجديدان غير متطابقين', true);
    if (!st.ok) return toast('لا يوجد اتصال بـ GitHub', true);
    const u = me(), d = await derive($('#pwOld').value, u.salt, st.auth.iterations);
    if (d.verifier !== u.verifier) return toast('الرمز الحالي غير صحيح', true);
    const nu = await newUser(u.email, $('#pwNew').value, st.conn.token, u.role);
    Object.assign(u, nu);
    try { await saveAuth(`تغيير الرمز السري ${u.email}`); toast('تم تغيير الرمز السري ✓'); e.target.reset(); } catch (err) { toast('تعذر الحفظ: ' + err.message, true); }
  };
  $('#addUserForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('#uEmail').value.trim().toLowerCase();
    if (st.auth.users.some(u => u.email === email)) return toast('المستخدم موجود مسبقاً', true);
    if (!st.ok) return toast('لا يوجد اتصال بـ GitHub', true);
    st.auth.users.push(await newUser(email, $('#uPass').value, st.conn.token, 'editor'));
    try { await saveAuth(`إضافة مستخدم ${email}`); toast('تمت إضافة المستخدم ✓'); e.target.reset(); renderUsers(); } catch (err) { toast('تعذر الحفظ: ' + err.message, true); }
  };

  /* ================= data ================= */
  const clean = e => {
    const out = { sessions: {}, times: {}, names: {}, hide_events: [...new Set(e.hide_events || [])].sort(), colors: Object.assign({}, e.colors || {}), events: e.events || [] };
    ['sessions', 'times', 'names'].forEach(k => Object.entries(e[k] || {}).forEach(([d, a]) => { if (a.some(Boolean)) out[k][d] = a; }));
    return out;
  };
  const sig = e => JSON.stringify(clean(e));
  const dirty = () => !!st.edits && sig(st.edits) !== st.saved;
  const exp = c => st.reg.experiences[c];
  const expName = c => c === 'X' ? 'بدون جلسة' : exp(c) ? exp(c).ar : c;
  const cls = c => (['A', 'L', 'X'].includes(c) ? c : 'O');
  const ymLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
  const editsPath = () => `data/${st.resort.id}/${st.month}.edits.json`;
  const sesOf = () => st.resort.sessions || st.base.sessions;

  /* time helpers: "7:30–8:30 PM" <-> ["19:30","20:30"] */
  function parseRange(s) {
    const [a, b] = s.split(/\s*[–-]\s*/); const sb = (b.match(/AM|PM/i) || a.match(/AM|PM/i) || ['PM'])[0].toUpperCase(); const sa = (a.match(/AM|PM/i) || [sb])[0].toUpperCase();
    const to24 = (x, suf) => { let [h, m] = x.replace(/\s*(AM|PM)/i, '').split(':').map(Number); if (suf === 'PM' && h !== 12) h += 12; if (suf === 'AM' && h === 12) h = 0; return `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`; };
    return [to24(a, sa), to24(b, sb)];
  }
  function fmtRange(a, b) {
    const f = t => { let [h, m] = t.split(':').map(Number); const suf = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return [`${h}:${String(m).padStart(2, '0')}`, suf]; };
    const [x, sx] = f(a), [y, sy] = f(b);
    return sx === sy ? `${x}–${y} ${sy}` : `${x} ${sx}–${y} ${sy}`;
  }

  async function boot(keepResort) {
    const f = await load('data/resorts.json');
    if (!f) { toast('تعذر تحميل data/resorts.json', true); return; }
    st.reg = f.json; st.regSha = f.sha;
    if (st.mode === 'cloud') AKUN.applyConfig(st.reg, await AKUN.cloudGet('config/resorts'));
    const prev = keepResort ? st.resort?.id : null;
    st.reg.resorts.sort((a, b) => (a.order || 99) - (b.order || 99));
    $('#resortSel').innerHTML = st.reg.resorts.map(r => `<option value="${r.id}">${esc(r.name.ar)} — ${esc(r.name.en)}</option>`).join('');
    if (prev) $('#resortSel').value = prev;
    pickResort($('#resortSel').value, keepResort ? st.month : null);
  }
  function pickResort(id, month) {
    st.resort = st.reg.resorts.find(r => r.id === id); $('#timesBox').hidden = true;
    const ms = st.resort.months || [];
    $('#monthSel').innerHTML = ms.map(m => `<option value="${m}">${ymLabel(m)}</option>`).join('') || '<option value="">لا توجد أشهر بعد</option>';
    const now = new Date(), cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const m = month && ms.includes(month) ? month : ms.includes(cur) ? cur : (ms.find(x => x > cur) || ms[ms.length - 1]);
    if (m) $('#monthSel').value = m;
    loadMonth(m);
  }
  async function loadMonth(m) {
    st.month = m; st.base = null; st.edits = null;
    if (!m) { $('#cal').innerHTML = ''; $('#evList').innerHTML = ''; return; }
    $('#cal').innerHTML = '<p class="muted">جاري التحميل…</p>';
    try {
      const b = await load(`data/${st.resort.id}/${m}.json`); if (!b) throw new Error();
      st.base = b.json;
      let e = null;
      if (st.mode === 'cloud') { const c = await AKUN.cloudGet(AKUN.editsDoc(st.resort.id, m)); e = c ? { json: c } : await load(editsPath()); }
      else e = await load(editsPath());
      st.edits = Object.assign(AKUN.emptyEdits(), e ? e.json : {}); st.sha = e ? e.sha : null; st.saved = sig(st.edits);
      render();
    } catch { $('#cal').innerHTML = `<p class="err-txt">تعذر تحميل بيانات ${ymLabel(m)}.</p>`; }
  }
  const guard = () => !dirty() || confirmSafe('لديك تعديلات غير محفوظة. تجاهلها؟');
  $('#resortSel').onchange = e => { if (guard()) pickResort(e.target.value); else e.target.value = st.resort.id; };
  $('#monthSel').onchange = e => { if (guard()) loadMonth(e.target.value); else e.target.value = st.month; };
  window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  /* ================= calendar ================= */
  function render() {
    const merged = AKUN.merge(st.base, st.edits, st.resort), ses = sesOf();
    const [y, m] = st.month.split('-').map(Number), first = new Date(y, m - 1, 1).getDay();
    $('#legend').innerHTML = ['A', 'L'].map(c => `<span><i class="sw ${c}"></i><b>${esc(expName(c))}</b></span>`).join('') +
      '<span><i class="sw X"></i>بدون جلسة (لا تظهر في الموقع)</span><span><i class="sw" style="background:#ff7a59;border-radius:50%;width:9px;height:9px"></i>معدّل يدوياً</span>';
    let h = DOWS.map(d => `<div class="dow">${d}</div>`).join('') + '<div class="day blank"></div>'.repeat(first);
    merged.days.forEach(x => {
      const ed = st.edits.sessions[x.d] || [], te = st.edits.times[x.d] || [], ne = st.edits.names[x.d] || [];
      const closed = x.s.every(c => c === 'X');
      h += `<div class="day${closed ? ' closed' : ''}"><div class="dhead"><span class="dnum" data-day="${x.d}" title="خيارات اليوم">${x.d}</span>
        <span class="dmoon">${x.moon ? `${x.moon.icon}<small>${x.moon.lit}%</small>` : ''}</span></div>
        <div class="slots">${x.s.map((c, i) => { const tm = (x.times && x.times[i]) || ses[i];
          return `<div class="slot ${cls(c)}${ed[i] || te[i] || ne[i] ? ' ed' : ''}" data-d="${x.d}" data-i="${i}" title="${esc(tm)}"><span>${esc((x.names && x.names[i]) || expName(c))}</span><span class="t" dir="ltr">${esc(tm.split(/[–-]/)[0].replace(/\s?(AM|PM)/, ''))}</span></div>`; }).join('')}</div></div>`;
    });
    $('#cal').innerHTML = h;
    $('#cal').querySelectorAll('.slot').forEach(el => el.onclick = ev => slotMenu(ev, +el.dataset.d, +el.dataset.i));
    $('#cal').querySelectorAll('.dnum').forEach(el => el.onclick = ev => dayMenu(ev, +el.dataset.day));
    renderEvents();
    $('#saveBar').hidden = !dirty();
    if (dirty()) $('#dirtyTxt').textContent = `تعديلات غير محفوظة على ${st.resort.name.ar} — ${ymLabel(st.month)}`;
  }

  const menu = $('#slotMenu');
  function openMenu(ev, html) {
    menu.innerHTML = html; menu.hidden = false;
    const r = ev.currentTarget.getBoundingClientRect(), mw = 240, mh = menu.offsetHeight;
    const x = Math.min(Math.max(8, r.left), innerWidth - mw - 8); let y = r.bottom + 6;
    if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    menu.style.left = x + 'px'; menu.style.top = y + 'px'; ev.stopPropagation();
  }
  document.addEventListener('click', e => { if (!e.target.closest('#slotMenu')) menu.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.hidden = true; closeDlg(); } });

  const nSes = () => sesOf().length;
  const autoOf = d => AKUN.merge(st.base, AKUN.emptyEdits(), st.resort).days.find(x => x.d === d).s;
  function setSlot(d, i, code) {
    const auto = autoOf(d)[i], n = nSes(d);
    const arr = (st.edits.sessions[d] || Array(n).fill('')).slice(); while (arr.length < n) arr.push('');
    arr[i] = code && code !== auto ? code : '';
    if (arr.some(Boolean)) st.edits.sessions[d] = arr; else delete st.edits.sessions[d];
    menu.hidden = true; render();
  }
  function setTime(d, i, val) {
    const n = nSes(d), arr = (st.edits.times[d] || Array(n).fill('')).slice(); while (arr.length < n) arr.push('');
    arr[i] = val && val !== sesOf()[i] ? val : '';
    if (arr.some(Boolean)) st.edits.times[d] = arr; else delete st.edits.times[d];
    menu.hidden = true; render();
  }
  function setName(d, i, val) {
    const n = nSes(d), arr = (st.edits.names[d] || Array(n).fill('')).slice(); while (arr.length < n) arr.push('');
    arr[i] = (val || '').trim();
    if (arr.some(Boolean)) st.edits.names[d] = arr; else delete st.edits.names[d];
    menu.hidden = true; render();
  }
  function slotMenu(ev, d, i) {
    const merged = AKUN.merge(st.base, st.edits, st.resort), day = merged.days.find(x => x.d === d), cur = day.s[i];
    const auto = autoOf(d)[i], usual = sesOf()[i], tm = (day.times && day.times[i]) || usual, [ta, tb] = parseRange(tm);
    const opt = c => `<button type="button" data-c="${c}" class="${cur === c ? 'cur' : ''}"><i class="sw ${c}"></i>${esc(expName(c))}${cur === c ? ' ✓' : ''}</button>`;
    openMenu(ev, `<div class="sub">${d} ${MONTHS[+st.month.slice(5) - 1]} · <span dir="ltr">${esc(tm)}</span></div>${opt('A')}${opt('L')}${opt('X')}
      <hr><div class="sub">🏷 اسم الجلسة في هذا اليوم</div>
      <div class="time-row"><input id="nmIn" style="flex:1" placeholder="مثال: جلسة خاصة – عائلة الأحمد" value="${esc((day.names && day.names[i]) || '')}"><button type="button" class="btn" id="nmOk">✓</button></div>
      <hr><div class="sub">⏰ وقت هذا اليوم فقط</div>
      <div class="time-row" dir="ltr"><input type="time" id="mtA" value="${ta}"><span>–</span><input type="time" id="mtB" value="${tb}"><button type="button" class="btn" id="mtOk">✓</button></div>
      ${tm !== usual ? `<button type="button" data-t="reset">↺ الوقت المعتاد (<span dir="ltr">${esc(usual)}</span>)</button>` : ''}
      <hr><div class="sub">تجربة أخرى (اسم مخصص)</div>
      <div class="time-row"><input id="custC" style="flex:1" placeholder="مثال: Private Event" value="${['A', 'L', 'X', ''].includes(cur) ? '' : esc(cur)}"><button type="button" class="btn" id="custOk">✓</button></div>
      ${cur !== auto ? `<hr><button type="button" data-c="__auto">↺ النوع التلقائي (${esc(expName(auto))})</button>` : ''}`);
    menu.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => setSlot(d, i, b.dataset.c === '__auto' ? '' : b.dataset.c));
    menu.querySelector('[data-t]') && (menu.querySelector('[data-t]').onclick = () => setTime(d, i, ''));
    $('#nmOk').onclick = () => setName(d, i, $('#nmIn').value);
    $('#nmIn').onkeydown = e => { if (e.key === 'Enter') $('#nmOk').click(); };
    $('#mtOk').onclick = () => { const a = $('#mtA').value, b = $('#mtB').value; if (a && b) setTime(d, i, fmtRange(a, b)); };
    $('#custOk').onclick = () => { const v = $('#custC').value.trim(); if (v) setSlot(d, i, v); };
    $('#custC').onkeydown = e => { if (e.key === 'Enter') $('#custOk').click(); };
  }
  function dayMenu(ev, d) {
    openMenu(ev, `<div class="sub">${DOW_FULL[new Date(+st.month.slice(0, 4), +st.month.slice(5) - 1, d).getDay()]} ${d} ${MONTHS[+st.month.slice(5) - 1]}</div>
      <button type="button" data-a="X">⛔ إلغاء جلسات اليوم (لا تظهر)</button>
      <button type="button" data-a="A"><i class="sw A"></i> كل الجلسات: ${esc(expName('A'))}</button>
      <button type="button" data-a="L"><i class="sw L"></i> كل الجلسات: ${esc(expName('L'))}</button>
      ${st.edits.sessions[d] || st.edits.times[d] || st.edits.names[d] ? '<hr><button type="button" data-a="reset">↺ إرجاع اليوم للتلقائي</button>' : ''}
      <hr><button type="button" data-a="event">+ إضافة فعالية في هذا اليوم</button>`);
    menu.querySelectorAll('button[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a; menu.hidden = true;
      if (a === 'event') return openEv(null, d);
      if (a === 'reset') { delete st.edits.sessions[d]; delete st.edits.times[d]; delete st.edits.names[d]; return render(); }
      const auto = autoOf(d), arr = auto.map(c => (c === a ? '' : a));
      if (arr.some(Boolean)) st.edits.sessions[d] = arr; else delete st.edits.sessions[d];
      render();
    });
  }

  /* ================= events ================= */
  function renderEvents() {
    const hidden = new Set(st.edits.hide_events);
    const all = (st.base.events || []).map(e => ({ ...e, _base: true })).concat(st.edits.events.map(e => ({ ...e, _custom: true })))
      .sort((a, b) => (a.days?.[0] || 0) - (b.days?.[0] || 0));
    const mn = MONTHS[+st.month.slice(5) - 1];
    $('#evList').innerHTML = all.length ? all.map(e => {
      const dd = e.days?.length ? (e.days.length > 1 ? `${e.days[0]}–${e.days[e.days.length - 1]} ${mn}` : `${e.days[0]} ${mn}`) : esc(e.date);
      const hid = e._base && hidden.has(e.id);
      const col = (e._custom ? e.color : st.edits.colors[e.id] || e.color) || '#dbfe52';
      return `<div class="evrow${hid ? ' hidden-ev' : ''}" style="--evc:${col}"><div class="ev-date"><button type="button" class="swatch-btn" data-color="${esc(e.id)}" data-custom="${e._custom ? 1 : ''}" title="لون الحدث" style="background:${col}"></button>${dd}</div>
        <div><span class="ttl">${esc(e.title_ar || e.title)}</span>${e._custom ? '<span class="tag c">مضافة يدوياً</span>' : e.auto ? '<span class="tag">تلقائي</span>' : ''}${hid ? '<span class="tag">مخفية</span>' : ''}
        <div class="muted small" dir="auto">${esc(e.title_ar ? e.title : '')}</div></div>
        <div class="acts">${e._custom
          ? `<button class="btn ghost" data-edit="${esc(e.id)}">تعديل</button><button class="btn danger" data-del="${esc(e.id)}">حذف</button>`
          : `<button class="btn ghost" data-edbase="${esc(e.id)}">تعديل</button><button class="btn ghost" data-hide="${esc(e.id)}">${hid ? 'إظهار' : 'إخفاء'}</button>`}</div></div>`;
    }).join('') : '<p class="muted">لا توجد أحداث لهذا الشهر.</p>';
    $('#evList').querySelectorAll('[data-color]').forEach(b => b.onclick = ev => {
      const id = b.dataset.color, custom = !!b.dataset.custom;
      openMenu(ev, `<div class="sub">لون الحدث</div><div class="swatches">${AKUN.EVENT_COLORS.map(c => `<button type="button" class="sw-pick" data-c="${c}" style="background:${c}"></button>`).join('')}</div>`);
      menu.querySelectorAll('.sw-pick').forEach(p => p.onclick = () => {
        if (custom) { const e = st.edits.events.find(x => x.id === id); if (e) e.color = p.dataset.c; }
        else if (p.dataset.c === AKUN.EVENT_COLORS[0]) delete st.edits.colors[id]; else st.edits.colors[id] = p.dataset.c;
        menu.hidden = true; render();
      });
    });
    $('#evList').querySelectorAll('[data-hide]').forEach(b => b.onclick = () => { const s = new Set(st.edits.hide_events); s.has(b.dataset.hide) ? s.delete(b.dataset.hide) : s.add(b.dataset.hide); st.edits.hide_events = [...s]; render(); });
    $('#evList').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { st.edits.events = st.edits.events.filter(e => e.id !== b.dataset.del); render(); });
    $('#evList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEv(st.edits.events.find(e => e.id === b.dataset.edit)));
    $('#evList').querySelectorAll('[data-edbase]').forEach(b => b.onclick = () => openEv({ ...st.base.events.find(e => e.id === b.dataset.edbase), _replaces: b.dataset.edbase }));
  }
  let editing = null;
  function openEv(e, day) {
    editing = e || null;
    const ses = sesOf(), nd = st.base.days.length;
    $('#evDlgTitle').textContent = e ? (e._replaces ? 'تعديل حدث تلقائي' : 'تعديل فعالية') : 'فعالية جديدة';
    $('#fFrom').max = $('#fTo').max = nd;
    $('#fFrom').value = e?.days?.[0] || day || 1; $('#fTo').value = e?.days?.[e.days.length - 1] || day || '';
    $('#fTitleAr').value = e?.title_ar || ''; $('#fTitle').value = e?.title || ''; $('#fDescAr').value = e?.desc_ar || ''; $('#fDesc').value = e?.desc || ''; $('#fHow').value = e?.how || '';
    const cur = (e && (e._replaces ? st.edits.colors[e._replaces] || e.color : e.color)) || AKUN.EVENT_COLORS[0];
    $('#fColor').innerHTML = AKUN.EVENT_COLORS.map(c => `<label class="sw-radio"><input type="radio" name="fcol" value="${c}" ${c === cur ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('');
    $('#fSes').innerHTML = ses.map((s, i) => `<label><input type="checkbox" data-i="${i}" ${(e ? e.sessions?.[i] : true) ? 'checked' : ''}><span dir="ltr">${esc(s)}</span></label>`).join('');
    $('#fDel').hidden = !(e && !e._replaces);
    $('#evDlg').hidden = false; $('#scrim').hidden = false; $('#fTitleAr').focus();
  }
  function closeDlg() { $('#evDlg').hidden = true; $('#scrim').hidden = true; editing = null; }
  $('#evClose').onclick = closeDlg; $('#scrim').onclick = closeDlg;
  $('#addEvBtn').onclick = () => openEv(null);
  $('#fDel').onclick = () => { if (editing) st.edits.events = st.edits.events.filter(e => e.id !== editing.id); closeDlg(); render(); };
  $('#evForm').onsubmit = ev => {
    ev.preventDefault();
    const nd = st.base.days.length, a = Math.min(nd, Math.max(1, +$('#fFrom').value)), b = Math.min(nd, Math.max(a, +($('#fTo').value || a)));
    const obj = { id: editing && !editing._replaces ? editing.id : `c-${st.month.replace('-', '')}${String(a).padStart(2, '0')}-${Date.now().toString(36)}`,
      days: Array.from({ length: b - a + 1 }, (_, k) => a + k), title_ar: $('#fTitleAr').value.trim(), title: $('#fTitle').value.trim() || $('#fTitleAr').value.trim(),
      desc_ar: $('#fDescAr').value.trim(), desc: $('#fDesc').value.trim() || $('#fDescAr').value.trim(), how: $('#fHow').value.trim(),
      sessions: [...$('#fSes').querySelectorAll('input')].map(x => x.checked), color: ($('#fColor input:checked') || {}).value || AKUN.EVENT_COLORS[0] };
    if (editing && editing._replaces) st.edits.hide_events = [...new Set([...st.edits.hide_events, editing._replaces])];
    const i = st.edits.events.findIndex(e => e.id === obj.id);
    if (i >= 0) st.edits.events[i] = obj; else st.edits.events.push(obj);
    closeDlg(); render();
  };

  /* ================= save month edits ================= */
  $('#revertBtn').onclick = () => { st.edits = Object.assign(AKUN.emptyEdits(), JSON.parse(st.saved)); render(); };
  $('#saveBtn').onclick = async () => {
    if (!st.ok) return toast('لا يوجد اتصال بـ GitHub — لا يمكن الحفظ من هذه الصفحة', true);
    const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'جاري الحفظ…';
    const obj = Object.assign(clean(st.edits), { updated_at: new Date().toISOString(), updated_by: st.user });
    try {
      if (st.mode === 'cloud') await AKUN.cloudSet(AKUN.editsDoc(st.resort.id, st.month), obj);
      else st.sha = await ghPut(editsPath(), obj, st.sha, `تعديل ${st.resort.name.ar} — ${ymLabel(st.month)} (${st.user})`);
      st.saved = sig(st.edits); render();
      toast(st.mode === 'cloud' ? 'تم الحفظ ✓ — ظاهر الآن لكل من يفتح الموقع' : 'تم الحفظ ✓ — يظهر لكل مستخدمي الموقع خلال دقيقة إلى دقيقتين');
    } catch (e) {
      toast(e.message === 'no-permission' ? 'حسابك في Claude لا يملك صلاحية الحفظ — اطلب من صاحب الصفحة مشاركتها معك بصلاحية Contributor أو Editor' : e.status === 409 || e.status === 422 ? 'الملف تغيّر من جهاز آخر — أعد تحميل الصفحة ثم عدّل مرة أخرى' : e.status === 403 ? 'المفتاح لا يملك صلاحية الكتابة' : 'تعذر الحفظ: ' + e.message, true);
    } finally { btn.disabled = false; btn.textContent = 'حفظ ونشر'; }
  };

  /* ================= session times editor ================= */
  function timeRow(lab, s) {
    const [a, b] = s ? parseRange(s) : ['20:00', '21:00'];
    return `<div class="trow"><input class="tl-ar" placeholder="اسم الجلسة (اختياري)" value="${esc(lab?.ar || '')}">
      <input class="tl-en" dir="ltr" placeholder="Session name (optional)" value="${esc(lab?.en || '')}">
      <span class="tt" dir="ltr"><input type="time" class="ta" value="${a}"><span>–</span><input type="time" class="tb" value="${b}"></span>
      <button class="btn danger trm" type="button" title="حذف الجلسة">✕</button></div>`;
  }
  function openTimes() {
    const r = st.resort; $('#tResort').textContent = r.name.ar; $('#tMsg').textContent = '';
    $('#tRows').innerHTML = r.sessions.map((s, i) => timeRow({ ar: r.session_labels?.ar?.[i], en: r.session_labels?.en?.[i] }, s)).join('');
    const od = (r.open_days || []).map(x => x.slice(0, 3).toLowerCase());
    $('#tDays').innerHTML = DOW_EN.map((d, i) => `<label><input type="checkbox" value="${d}" ${!od.length || od.includes(d.toLowerCase()) ? 'checked' : ''}>${DOW_FULL[i]}</label>`).join('');
    bindRows(); $('#timesBox').hidden = false; $('#timesBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const bindRows = () => $('#tRows').querySelectorAll('.trm').forEach(b => b.onclick = () => { if ($('#tRows').children.length > 1) b.closest('.trow').remove(); });
  $('#timesBtn').onclick = () => $('#timesBox').hidden ? openTimes() : ($('#timesBox').hidden = true);
  $('#tCancel').onclick = () => $('#timesBox').hidden = true;
  $('#tAdd').onclick = () => { $('#tRows').insertAdjacentHTML('beforeend', timeRow(null, null)); bindRows(); };
  $('#tSave').onclick = async () => {
    if (!st.ok) return toast('لا يوجد اتصال بـ GitHub — لا يمكن الحفظ من هذه الصفحة', true);
    const rows = [...$('#tRows').querySelectorAll('.trow')];
    const sessions = rows.map(r => fmtRange(r.querySelector('.ta').value, r.querySelector('.tb').value));
    const lar = rows.map(r => r.querySelector('.tl-ar').value.trim()), len = rows.map(r => r.querySelector('.tl-en').value.trim());
    const days = [...$('#tDays').querySelectorAll('input:checked')].map(x => x.value);
    if (!days.length) return toast('اختر يوماً واحداً على الأقل', true);
    const r = st.resort, countChanged = sessions.length !== r.sessions.length;
    if (countChanged && !confirmSafe('تغيّر عدد الجلسات — تعديلات الأيام السابقة قد لا تطابق الجلسات الجديدة. متابعة؟')) return;
    $('#tSave').disabled = true; $('#tMsg').textContent = 'جاري الحفظ…';
    try {
      const fresh = st.mode === 'cloud' ? { json: JSON.parse(JSON.stringify(st.reg)) } : await ghGet('data/resorts.json'); const reg = fresh.json; const rr = reg.resorts.find(x => x.id === r.id);
      rr.sessions = sessions;
      if (lar.some(Boolean) || len.some(Boolean)) rr.session_labels = { ar: lar, en: len.map((x, i) => x || lar[i]) }; else delete rr.session_labels;
      rr.open_days = days.length === 7 ? [] : days;
      rr.tagline = days.length === 7 ? { en: 'Every night', ar: 'يومياً' }
        : days.length === 1 ? { en: `${days[0]}days only`.replace('Fridays', 'Fridays'), ar: `كل ${DOW_FULL[DOW_EN.indexOf(days[0])].replace('ال', '')}` }
        : { en: days.join(' · '), ar: days.map(d => DOW_FULL[DOW_EN.indexOf(d)]).join(' · ') };
      if (days.length === 1) rr.tagline.en = { Sun: 'Sundays', Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays' }[days[0]] + ' only';
      if (days.length === 1) rr.tagline.ar = `كل ${{ Sun: 'أحد', Mon: 'اثنين', Tue: 'ثلاثاء', Wed: 'أربعاء', Thu: 'خميس', Fri: 'جمعة', Sat: 'سبت' }[days[0]]}`;
      if (st.mode === 'cloud') {
        const cfg = (await AKUN.cloudGet('config/resorts')) || { resorts: {} }; cfg.resorts = cfg.resorts || {};
        cfg.resorts[r.id] = { sessions: rr.sessions, session_labels: rr.session_labels || null, open_days: rr.open_days, tagline: rr.tagline };
        await AKUN.cloudSet('config/resorts', cfg);
        st.reg = reg; st.resort = rr; $('#tMsg').innerHTML = '<span class="ok-txt">تم الحفظ ✓ — ظاهر الآن في الموقع</span>'; render(); return;
      }
      st.regSha = await ghPut('data/resorts.json', reg, fresh.sha, `تعديل أوقات جلسات ${r.name.ar} (${st.user})`);
      const ok = await dispatch('', true, r.id);
      $('#tMsg').innerHTML = `<span class="ok-txt">تم الحفظ ✓ ${ok ? '— يُعاد توليد الجداول الآن، وتظهر الأوقات الجديدة خلال ٢–٣ دقائق' : '— لم يبدأ إعادة التوليد تلقائياً، شغّله من «توليد شهر»'}</span>`;
      st.reg = reg; st.resort = rr;
    } catch (e) { $('#tMsg').innerHTML = `<span class="err-txt">${e.message === 'no-permission' ? 'حسابك في Claude لا يملك صلاحية الحفظ' : 'تعذر الحفظ: ' + esc(e.message)}</span>`; }
    finally { $('#tSave').disabled = false; }
  };

  /* ================= generate month ================= */
  $('#genBtn').onclick = () => {
    const box = $('#genBox'); box.hidden = !box.hidden;
    if (!box.hidden && !$('#genMonth').value) { const d = new Date(); d.setMonth(d.getMonth() + 1); $('#genMonth').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  };
  $('#genGo').onclick = async () => {
    if (!st.ok) return toast('لا يوجد اتصال بـ GitHub', true);
    const m = $('#genMonth').value; if (!/^\d{4}-\d{2}$/.test(m)) return toast('اختر شهراً', true);
    $('#genMsg').textContent = '…';
    $('#genMsg').innerHTML = await dispatch(m, $('#genForce').checked, $('#genForce').checked ? st.resort.id : '')
      ? `<span class="ok-txt">بدأ التوليد ✓ — حدّث الصفحة بعد ٢–٣ دقائق ليظهر ${ymLabel(m)}</span>`
      : '<span class="err-txt">تعذر التشغيل — تأكد من صلاحية Actions: Read and write في مفتاح الوصول</span>';
  };

  /* ================= start ================= */
  (async () => {
    st.mode = (await AKUN.cloud()) ? 'cloud' : 'github';
    const s = ss.get('akun-session');
    if (s && st.mode === 'cloud' && s.mode === 'cloud') { st.user = s.user; await enter(); }
    else if (s && st.mode === 'github' && s.conn && s.conn.token) { st.user = s.user; st.conn = s.conn; await enter(); }
    else { show('#loginScreen'); $('#lEmail').focus(); }
  })();
})();
