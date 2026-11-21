/* AKUN Availability — static site (GitHub Pages). Data lives in /data. */
(() => {
  const $ = s => document.querySelector(s);
  const T = {
    ar: {
      siteTitle: 'جدول الإتاحة', edit: 'تعديل', heroTitle: 'جدول الإتاحة',
      heroSub: 'جلسات الفلك الشهرية في منتجعات البحر الأحمر', view: 'عرض الجدول', pick: 'اختر المنتجع', off: 'غير متاح', details: 'تفاصيل التجربة', loc: 'المكان', prices: 'الأسعار',
      searchPh: 'اسم المنتجع…', noMatch: 'لا يوجد منتجع بهذا الاسم', viewCal: 'تقويم', viewList: 'قائمة',
      events: 'أحداث فلكية خلال الجلسات', booking: 'متطلبات الحجز', bookingSub: 'كل حجز مؤكد يجب أن يتضمن:',
      cap: n => `السعة القصوى ${n} أشخاص`, sessions: n => `${n} جلسات في الليلة`,
      sessionsWord: 'الجلسات', noMonth: 'لا يوجد جدول منشور لهذا الشهر بعد.', noEvents: 'لا توجد أحداث مسجلة لهذا الشهر.',
      colDate: 'التاريخ', colDay: 'اليوم', colMoon: 'القمر', colLit: 'الإضاءة', colMoonT: 'القمر الليلة', colHl: 'حدث الليلة',
      moonLit: 'مضاء', session: 'الجلسة', evOn: 'خلال الجلسات', loadErr: 'تعذر تحميل البيانات.',
      months: ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'],
      dow: ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'],
      dowS: ['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'],
      short: { A: 'الفلك العربي', L: 'ليلة القمر', X: 'غير متاح' }, available: 'الأشهر المتاحة'
    },
    en: {
      siteTitle: 'Availability Calendar', edit: 'Edit', heroTitle: 'Availability Calendar',
      heroSub: 'Monthly astronomy sessions at the Red Sea resorts', view: 'View schedule', pick: 'Choose a resort', off: 'Not available', details: 'Experience details', loc: 'Location', prices: 'Prices',
      searchPh: 'Resort name…', noMatch: 'No resort matches that name', viewCal: 'Calendar', viewList: 'List',
      events: 'Sky events during sessions', booking: 'Booking requirements', bookingSub: 'Each confirmed booking must include:',
      cap: n => `Max capacity ${n} pax`, sessions: n => `${n} sessions per night`,
      sessionsWord: 'Sessions', noMonth: 'No schedule has been published for this month yet.', noEvents: 'No events listed for this month.',
      colDate: 'Date', colDay: 'Day', colMoon: 'Moon', colLit: 'Lit', colMoonT: 'Moon tonight', colHl: "Tonight's highlight",
      moonLit: 'lit', session: 'Session', evOn: 'During sessions', loadErr: 'Could not load data.',
      months: ['January','February','March','April','May','June','July','August','September','October','November','December'],
      dow: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
      dowS: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
      short: { A: 'Arabian', L: 'Lunar', X: 'N/A' }, available: 'Available months'
    }
  };
  let lang = localStorage.getItem('akun-lang') || 'ar';
  const t = k => T[lang][k];
  const st = { reg: null, resort: null, month: null, view: 'cal', cache: {} };

  /* ---------- helpers ---------- */
  const norm = s => (s || '').toLowerCase()
    .replace(/[ً-ٰٟ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/^ال/, '').replace(/\s+/g, ' ').trim();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const timeTxt = s => lang === 'ar' ? s.replace(/PM/g, 'م').replace(/AM/g, 'ص') : s;
  const tH = s => lang === 'ar'
    ? esc(s).replace(/(\d{1,2}:\d{2}(?:\s?[–-]\s?\d{1,2}:\d{2})?)/g, '<bdi dir="ltr">$1</bdi>').replace(/PM/g, 'م').replace(/AM/g, 'ص')
    : esc(s);
  const withSuf = (part, whole) => /AM|PM/.test(part) ? part.trim() : part.trim() + ' ' + (whole.match(/AM|PM/) || [''])[0];
  const startTime = s => timeTxt(s.split(/[–-]/)[0].replace(/\s?(PM|AM)/, ''));
  const sesLabel = i => st.resort?.session_labels?.[lang]?.[i];
  const has = c => c && c !== 'X';
  const evColor = e => /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : 'var(--lime)';
  const dayName = (x, i) => x.names && x.names[i];                       // 'X' = no session → not shown at all
  const dayTime = (x, i) => (x.times && x.times[i]) || (st.data.sessions || st.resort.sessions)[i];
  const exp = c => st.reg.experiences[c];
  const expName = c => exp(c) ? exp(c)[lang] : c;
  const cls = c => (['A', 'L', 'X'].includes(c) ? c : 'O');
  const ymLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${t('months')[m - 1]} ${y}`; };
  const todayYM = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

  async function getJSON(url) {
    if (st.cache[url]) return st.cache[url];
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return (st.cache[url] = await r.json());
  }

  /* ---------- i18n ---------- */
  function applyLang() {
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach(e => e.textContent = t(e.dataset.i18n));
    document.querySelectorAll('[data-i18n-ph]').forEach(e => e.placeholder = t(e.dataset.i18nPh));
    $('#langBtn').textContent = lang === 'ar' ? 'EN' : 'عربي';
    document.title = lang === 'ar' ? 'أكون | جدول الإتاحة' : 'AKUN | Availability';
    renderChips();
    if (st.resort) render();
  }
  $('#langBtn').onclick = () => { lang = lang === 'ar' ? 'en' : 'ar'; localStorage.setItem('akun-lang', lang); applyLang(); };

  function renderChips() {
    if (!st.reg) return;
    const rs = st.reg.resorts.slice().sort((a, b) => (a.order || 99) - (b.order || 99));
    $('#allResorts').innerHTML = rs.map(r => `<button class="rcard" type="button" data-id="${r.id}">
        <span class="rc-name">${esc(r.name[lang])}</span>
        <span class="rc-venue">${esc(r.venue?.[lang] || '')}</span>
        <span class="rc-days">${esc(r.tagline?.[lang] || '')}</span>
        <span class="rc-meta">${r.sessions.length} ${lang === 'ar' ? 'جلسات' : 'sessions'} · ${t('cap')(r.capacity)}</span>
        <span class="rc-go">${t('view')} <i>${lang === 'ar' ? '←' : '→'}</i></span>
      </button>`).join('');
    $('#allResorts').querySelectorAll('.rcard').forEach(b => b.onclick = () => openResort(b.dataset.id));
  }

  function setPicker(open) {
    $('#allResorts').hidden = !open; $('#pickBtn').setAttribute('aria-expanded', open);
    $('#pickBtn').classList.toggle('open', open);
    if (open) $('#allResorts').querySelector('.rcard')?.focus({ preventScroll: true });
  }
  $('#pickBtn').onclick = () => setPicker($('#allResorts').hidden);

  /* ---------- routing ---------- */
  function setHash() { location.hash = st.resort ? `/${st.resort.id}/${st.month || ''}/${st.view}` : ''; }
  function fromHash() {
    const [id, m, v] = location.hash.replace(/^#\/?/, '').split('/');
    const r = st.reg.resorts.find(x => x.id === id);
    if (!r) { st.resort = null; $('#view').hidden = true; $('#hero').hidden = false; setPicker(false); return; }
    st.resort = r; st.view = v === 'list' ? 'list' : 'cal';
    st.month = r.months.includes(m) ? m : pickMonth(r);
    $('#hero').hidden = true; $('#view').hidden = false;
    render();
  }
  function pickMonth(r) {
    const now = todayYM(), ms = r.months || [];
    if (!ms.length) return null;
    return ms.includes(now) ? now : (ms.find(m => m > now) || ms[ms.length - 1]);
  }
  function openResort(id) { const r = st.reg.resorts.find(x => x.id === id); st.resort = r; st.month = pickMonth(r); st.view = 'cal'; setHash(); window.scrollTo({ top: 0 }); }
  window.addEventListener('hashchange', fromHash);
  $('#homeLink').onclick = e => { e.preventDefault(); st.resort = null; history.pushState('', '', location.pathname); fromHash(); };

  /* ---------- render ---------- */
  async function render() {
    const r = st.resort;
    $('#rName').textContent = r.name[lang];
    $('#rVenue').textContent = (r.venue?.[lang] || '').toUpperCase();
    $('#rMeta').innerHTML = `<span>👥 ${t('cap')(r.capacity)}</span><span>🕗 ${tH(withSuf(r.sessions[0].split(/[–-]/)[0], r.sessions[0]) + ' – ' + r.sessions[r.sessions.length - 1].split(/[–-]/).pop().trim())}</span><span>${t('sessions')(r.sessions.length)}</span>${r.tagline ? `<span>📅 ${esc(r.tagline[lang])}</span>` : ''}`;
    renderInfo(r);
    const bk = r.booking || st.reg.booking || {};
    $('#booking').innerHTML = (bk[lang] || []).map(x => `<li>${esc(x)}</li>`).join('');
    $('#bookNote').hidden = !r.booking_note; if (r.booking_note) $('#bookNote').textContent = r.booking_note[lang];
    document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.v === st.view));
    $('#legend').innerHTML = ['A', 'L'].map(c => `<span><i class="sw ${c}"></i><b>${esc(expName(c))}</b> — ${esc(exp(c)['desc_' + lang])}</span>`).join('') + `<span><i class="sw ev"></i>${lang === 'ar' ? 'حدث فلكي' : 'Sky event'}</span>`;
    const i = r.months.indexOf(st.month);
    $('#prevM').disabled = i <= 0; $('#nextM').disabled = i < 0 || i >= r.months.length - 1;
    $('#mLabel').textContent = st.month ? ymLabel(st.month) : '—';
    $('#updated').textContent = r.months.length ? `${t('available')}: ${r.months.map(ymLabel).join(' · ')}` : '';
    if (!st.month) { noMonth(); return; }
    let data;
    try { data = await getJSON(`data/${r.id}/${st.month}.json`); }
    catch { noMonth(); return; }
    const cloudEdits = await AKUN.cloudGet(AKUN.editsDoc(r.id, st.month));
    const edits = cloudEdits || await getJSON(`data/${r.id}/${st.month}.edits.json`).catch(() => null);
    data = AKUN.merge(data, edits, r);
    $('#noData').hidden = true; $('.toolbar').hidden = false; $('#legend').hidden = false; $('.grid2').hidden = false;
    st.data = data;
    renderStats(data); renderCal(data); renderList(data); renderEvents(data);
    $('#cal').hidden = st.view !== 'cal'; $('#list').hidden = st.view !== 'list';
  }
  function renderInfo(r) {
    const cur = r.currency?.[lang] || '';
    const rows = [];
    if (r.location) rows.push(`<div class="irow"><span class="ik">📍 ${t('loc')}</span><span>${esc(r.location[lang])}</span></div>`);
    if (r.session_labels) rows.push(`<div class="irow"><span class="ik">🕗 ${t('sessionsWord')}</span><span>${r.sessions.map((s, i) => `${esc(sesLabel(i))} · ${tH(s.split(/[–-]/)[0].trim() + (/[AP]M/.test(s.split(/[–-]/)[0]) ? '' : ' ' + (s.match(/AM|PM/) || [''])[0]))}`).join('<br>')}</span></div>`);
    if (r.prices) rows.push(`<div class="irow"><span class="ik">💳 ${t('prices')}</span><span class="prices">${r.prices.map(p => `<span class="pr"><small>${esc(p.label[lang])}</small><b>${p.price} ${esc(cur)}</b>${p.was ? `<s>${p.was} ${esc(cur)}</s>` : ''}</span>`).join('')}</span></div>`);
    if (r.deadline) rows.push(`<div class="deadline">⏰ ${esc(r.deadline[lang])}</div>`);
    if (r.notes) rows.push(`<ul class="notes">${r.notes[lang].map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
    $('#info').innerHTML = rows.join('');
    $('#infoCard').hidden = !rows.length;
    $('#offer').hidden = !r.offer; if (r.offer) $('#offer').textContent = r.offer[lang];
  }
  function noMonth() {
    ['#cal', '#list', '.toolbar', '#legend', '.grid2'].forEach(s => $(s).hidden = true);
    const n = $('#noData'); n.textContent = t('noMonth'); n.hidden = false;
  }
  $('#prevM').onclick = () => { const ms = st.resort.months, i = ms.indexOf(st.month); if (i > 0) { st.month = ms[i - 1]; setHash(); } };
  $('#nextM').onclick = () => { const ms = st.resort.months, i = ms.indexOf(st.month); if (i < ms.length - 1) { st.month = ms[i + 1]; setHash(); } };
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { st.view = b.dataset.v; setHash(); });

  const sessionsOf = d => st.data.sessions || st.resort.sessions;
  const evFor = (data, d) => (data.events || []).filter(e => (e.days || []).includes(d));
  const isToday = d => { const n = new Date(); return st.month === todayYM() && n.getDate() === d; };
  const dowOf = d => { const [y, m] = st.month.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

  function renderStats(data) {
    const cnt = {}; data.days.forEach(x => x.s.forEach(c => { if (c) cnt[c] = (cnt[c] || 0) + 1; }));
    $('#stats').innerHTML = Object.keys(cnt).filter(c => c !== 'X').sort().map(c =>
      `<div class="stat"><i class="dot sw ${cls(c)}"></i><b>${cnt[c]}</b><span class="muted">${esc(expName(c))}</span></div>`).join('');
  }
  function renderCal(data) {
    const ses = sessionsOf();
    let h = t('dowS').map(d => `<div class="dow">${d}</div>`).join('');
    h += '<div class="day blank"></div>'.repeat(dowOf(1));
    data.days.forEach(x => {
      const evs = evFor(data, x.d);
      if (!x.s.some(has)) { h += `<div class="day off${isToday(x.d) ? ' today' : ''}"><div class="dhead"><span class="dnum">${x.d}</span></div></div>`; return; }
      h += `<button type="button" class="day${isToday(x.d) ? ' today' : ''}" data-d="${x.d}">
        <div class="dhead"><span class="dnum">${x.d}</span><span class="dmoon">${evs.map(e => `<i class="evdot" style="background:${evColor(e)}"></i>`).join('')}${x.moon ? `${x.moon.icon}<small>${x.moon.lit}%</small>` : ''}</span></div>
        <div class="slots">${x.s.map((c, i) => has(c) ? `<div class="slot ${cls(c)}" title="${esc(dayTime(x, i))} — ${esc(expName(c))}${dayName(x, i) ? ' — ' + esc(dayName(x, i)) : ''}"><span>${esc(dayName(x, i) || t('short')[c] || c)}</span><span class="t" dir="ltr">${esc(startTime(dayTime(x, i)))}</span></div>` : '').join('')}</div>
      </button>`;
    });
    $('#cal').innerHTML = h;
    $('#cal').querySelectorAll('.day[data-d]').forEach(b => b.onclick = () => openDay(+b.dataset.d));
  }
  function renderList(data) {
    const ses = sessionsOf();
    let h = `<table><thead><tr><th>${t('colDate')}</th><th>${t('colDay')}</th><th>${t('colMoon')}</th><th>${t('colMoonT')}</th>${ses.map((s, i) => `<th>${sesLabel(i) ? `<div>${esc(sesLabel(i))}</div>` : ''}${tH(s)}</th>`).join('')}<th>${t('colHl')}</th></tr></thead><tbody>`;
    data.days.forEach(x => {
      if (!x.s.some(has)) return;
      const dw = dowOf(x.d), evs = evFor(data, x.d);
      h += `<tr class="${dw === 6 ? 'sat' : ''}${isToday(x.d) ? ' today' : ''}" data-d="${x.d}"><td><b>${x.d}</b></td><td class="muted">${t('dowS')[dw]}</td>
        <td>${x.moon ? `${x.moon.icon} <span class="muted small">${x.moon.lit}%</span>` : ''}</td><td class="muted small">${x.moon ? esc(x.moon.note[lang]) : ''}</td>
        ${x.s.map((c, i) => `<td>${has(c) ? `<span class="pill ${cls(c)}">${esc(expName(c))}</span>${dayName(x, i) ? `<div class="small">${esc(dayName(x, i))}</div>` : ''}${x.times && x.times[i] ? `<div class="small hl">${tH(x.times[i])}</div>` : ''}` : ''}</td>`).join('')}
        <td class="hl">${evs.map(e => `<span style="color:${evColor(e)}">${esc(lang === 'ar' && e.title_ar ? e.title_ar : e.title)}</span>`).join(' · ')}</td></tr>`;
    });
    $('#list').innerHTML = h + '</tbody></table>';
    $('#list').querySelectorAll('tr[data-d]').forEach(tr => tr.onclick = () => openDay(+tr.dataset.d));
  }
  const evDate = e => {
    if (!e.days?.length) return esc(e.date || '');
    const [y, m] = st.month.split('-').map(Number), mn = t('months')[m - 1], a = e.days[0], b = e.days[e.days.length - 1];
    if (lang !== 'ar') return a === b ? `${t('dowS')[dowOf(a)]}, ${mn.slice(0, 3)} ${a}` : `${mn.slice(0, 3)} ${a}–${b}`;
    return a === b ? `${t('dow')[dowOf(a)]} ${a} ${mn}` : `${a}–${b} ${mn}`;
  };
  const evDesc = e => esc(lang === 'ar' && e.desc_ar ? e.desc_ar : e.desc);
  function sesBadges(e) {
    const ses = sessionsOf();
    return `<div class="ses">${(e.sessions || []).map((on, i) => `<span class="${on ? 'on' : ''}">${esc(startTime(ses[i] || ''))}</span>`).join('')}</div>`;
  }
  function renderEvents(data) {
    const evs = data.events || [];
    $('#events').innerHTML = evs.length ? evs.map(e => `<div class="ev" style="--evc:${evColor(e)}"><div class="ev-date">${evDate(e)}</div><div>
      <h4>${esc(lang === 'ar' && e.title_ar ? e.title_ar : e.title)}</h4>
      <div class="muted small" dir="auto">${[(lang === 'ar' ? e.title : e.title_ar), e.how && e.how !== '—' ? e.how : ''].filter((x, k) => x && (k || x !== (lang === 'ar' && e.title_ar ? e.title_ar : e.title))).map(esc).join(' · ')}</div>
      <p dir="auto">${evDesc(e)}</p>${sesBadges(e)}</div></div>`).join('') : `<p class="muted">${t('noEvents')}</p>`;
  }

  /* ---------- day drawer ---------- */
  function openDay(d) {
    const x = st.data.days.find(y => y.d === d), ses = sessionsOf(), [yy, mm] = st.month.split('-').map(Number);
    const evs = evFor(st.data, d);
    $('#dBody').innerHTML = `<div class="d-date">${t('dow')[dowOf(d)]}</div>
      <h3>${d} ${t('months')[mm - 1]} ${yy}</h3>
      ${x.moon ? `<div class="moonbox"><span class="big">${x.moon.icon}</span><div><b>${x.moon.lit}% ${t('moonLit')}</b><div class="muted small">${esc(x.moon.note[lang])}</div></div></div>` : ''}
      ${x.s.map((c, i) => has(c) ? `<div class="d-slot ${cls(c)}"><span>${esc(dayName(x, i) || sesLabel(i) || t('session') + ' ' + (i + 1))}<small>${tH(dayTime(x, i))}</small></span><span>${esc(expName(c))}</span></div>` : '').join('')}
      ${evs.map(e => `<div class="d-ev" style="--evc:${evColor(e)}"><b>${esc(lang === 'ar' && e.title_ar ? e.title_ar : e.title)}</b><p dir="auto">${evDesc(e)}</p></div>`).join('')}`;
    $('#drawer').hidden = false; $('#scrim').hidden = false; $('#closeD').focus();
  }
  const closeDay = () => { $('#drawer').hidden = true; $('#scrim').hidden = true; };
  $('#closeD').onclick = closeDay; $('#scrim').onclick = closeDay;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDay(); });

  /* ---------- boot ---------- */
  getJSON('data/resorts.json').then(async reg => {
    st.reg = AKUN.applyConfig(JSON.parse(JSON.stringify(reg)), await AKUN.cloudGet('config/resorts'));
    applyLang(); fromHash();
  })
    .catch(() => { const n = $('#noData'); n.textContent = T[lang].loadErr; n.hidden = false; });
})();
