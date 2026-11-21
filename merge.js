/* Shared by the site and the editor.

   A month on screen = generated file  data/<resort>/<YYYY-MM>.json
                     + manual edits    (cloud database when the page runs as a Claude artifact,
                                        otherwise data/<resort>/<YYYY-MM>.edits.json on GitHub)
   Edits:
   {
     "sessions":    { "17": ["", "X"] },             // experience per session ("" = automatic, "X" = no session)
     "times":       { "20": ["8:00–9:00 PM", ""] },  // a different time on that day only
     "names":       { "20": ["جلسة خاصة", ""] },     // a name for that day's session
     "hide_events": ["fq-20261217-moon"],             // automatic events to hide
     "colors":      { "fq-20261217-moon": "#ff7a59" },// colour of an automatic event
     "events":      [ { "id", "days", "title", "title_ar", "desc", "desc_ar", "how", "sessions", "color" } ]
   }                                                                                                     */
window.AKUN = window.AKUN || {};
AKUN.emptyEdits = () => ({ sessions: {}, times: {}, names: {}, hide_events: [], colors: {}, events: [] });
AKUN.EVENT_COLORS = ['#dbfe52', '#7cc4ff', '#ff7a59', '#c792ea', '#ffd166', '#4dd4ac', '#ff6b9a', '#ffffff'];
const DOW3 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/* resort = the resort as configured now (operating days + session times may have been edited) */
AKUN.merge = (base, edits, resort) => {
  edits = Object.assign(AKUN.emptyEdits(), edits || {});
  const out = JSON.parse(JSON.stringify(base));
  const [y, m] = (base.month || '2000-01').split('-').map(Number);
  const open = ((resort && resort.open_days) || []).map(x => x.slice(0, 3).toLowerCase());
  const n = resort && resort.sessions ? resort.sessions.length : (base.sessions || []).length;
  if (resort && resort.sessions) out.sessions = resort.sessions.slice();
  out.days.forEach(day => {
    // session count changed in the editor → pad with the last session's experience / trim
    while (day.s.length < n) day.s.push(day.s[day.s.length - 1] || 'A');
    if (day.s.length > n) day.s.length = n;
    const dow = DOW3[new Date(y, m - 1, day.d).getDay()];
    day.closed = open.length > 0 && !open.includes(dow);
    if (day.closed) day.s = day.s.map(() => 'X');
    day.auto = day.s.slice();
    const tm = edits.times[day.d]; if (tm && tm.some(Boolean)) day.times = tm.slice(0, n);
    const nm = edits.names[day.d]; if (nm && nm.some(Boolean)) day.names = nm.slice(0, n);
    const ov = edits.sessions[day.d];
    if (ov) { day.s = day.s.map((c, i) => (ov[i] ? ov[i] : c)); day.edited = day.s.map((_, i) => Boolean(ov[i])); }
  });
  const openDays = new Set(out.days.filter(d => d.s.some(c => c && c !== 'X')).map(d => d.d));
  const hidden = new Set(edits.hide_events || []);
  out.events = (out.events || []).filter(e => !hidden.has(e.id))
    .map(e => Object.assign({}, e, { days: (e.days || []).filter(d => openDays.has(d)) }, edits.colors[e.id] ? { color: edits.colors[e.id] } : {}))
    .filter(e => e.days.length)
    .concat((edits.events || []).map(e => Object.assign({ custom: true }, e)))
    .sort((a, b) => (a.days?.[0] || 0) - (b.days?.[0] || 0));
  return out;
};

/* ---------- cloud storage (Claude artifact database) ---------- */
AKUN.cloud = (() => {
  let p;
  return () => p || (p = (async () => {
    if (!window.claude || typeof window.claude.use !== 'function') return null;
    try { return await Promise.race([window.claude.use('db'), new Promise(r => setTimeout(() => r(null), 8000))]); }
    catch { return null; }
  })());
})();
AKUN.editsDoc = (resort, month) => `edits/${resort}__${month}`;
AKUN.cloudGet = async path => {
  const db = await AKUN.cloud(); if (!db) return null;
  try { const s = await db.doc(path).get(); return s.exists ? JSON.parse(JSON.stringify(s.data())) : null; } catch { return null; }
};
AKUN.cloudSet = async (path, data) => {
  const db = await AKUN.cloud(); if (!db) throw new Error('no cloud');
  try { await db.doc(path).set(data); }
  catch (e) {
    if (e && e.code === 'unavailable') { await new Promise(r => setTimeout(r, 600 + Math.random() * 800)); return db.doc(path).set(data); }
    const err = new Error(e && e.code === 'invalid_argument' ? 'no-permission' : (e && e.message) || 'save failed'); err.code = e && e.code; throw err;
  }
};
/* resort settings edited in the editor (session times, labels, operating days) */
AKUN.applyConfig = (reg, cfg) => {
  if (!cfg || !cfg.resorts) return reg;
  reg.resorts.forEach(r => { const o = cfg.resorts[r.id]; if (o) Object.assign(r, o); });
  return reg;
};
