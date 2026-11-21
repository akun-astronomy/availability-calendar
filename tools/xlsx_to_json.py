#!/usr/bin/env python3
"""
تحويل ملف الإتاحة الشهري (Excel) إلى ملف JSON يقرأه الموقع.
Convert a monthly availability workbook (AKUN template) into the site's JSON.

الاستخدام / Usage:
    python tools/xlsx_to_json.py "AKUN_Astronomy_Dec-2026.xlsx" --resort desert-rock

يحفظ الملف في: data/<resort>/<YYYY-MM>.json  ويضيف الشهر تلقائياً إلى data/resorts.json
Needs: pip install openpyxl   (optional for moon info: pip install ephem)
"""
import argparse, json, math, re, sys, datetime as dt
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
MONTHS = {m.lower(): i for i, m in enumerate(
    ['January','February','March','April','May','June','July','August','September','October','November','December'], 1)}
MON3 = {k[:3]: v for k, v in MONTHS.items()}

def code_for(label):
    if not label: return ''
    t = str(label).strip().lower()
    if 'lunar' in t: return 'L'
    if 'arabian' in t: return 'A'
    if t in ('closed', 'x', 'مغلق', 'n/a', '—', '-'): return 'X'
    return str(label).strip()          # any other experience name is kept as-is

def find_month(ws):
    for row in ws.iter_rows(max_row=8):
        for c in row:
            if isinstance(c.value, str):
                m = re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})', c.value, re.I)
                if m: return int(m.group(2)), MONTHS[m.group(1).lower()]
    return None

def parse_classic(ws):
    """Original template: weekly blocks, column B = 'TIME', C..I = 'Sun 1' ... """
    days, sessions = {}, []
    rows = list(ws.iter_rows())
    for i, row in enumerate(rows):
        if str(row[1].value or '').strip().upper() == 'TIME':
            heads = [(c.column, c.value) for c in row[2:9]]
            for k in range(1, 5):
                r = rows[i + k]
                t = str(r[1].value or '').strip()
                if t and t not in sessions and len(sessions) < 4: sessions.append(t)
                for col, h in heads:
                    m = re.search(r'(\d+)', str(h or ''))
                    if not m: continue
                    d = int(m.group(1))
                    days.setdefault(d, ['', '', '', ''])[k - 1] = code_for(ws.cell(r[0].row, col).value)
    return days, sessions

def parse_v2(ws):
    """Redesigned template: sheet 'Calendar', header row with 'Date', session columns F..I."""
    days, sessions = {}, []
    hdr = None
    for row in ws.iter_rows():
        if str(row[0].value or '').strip() == 'Date': hdr = row; sessions = [str(c.value) for c in row[5:9]]; continue
        if hdr and row[0].value:
            m = re.search(r'(\d+)', str(row[0].value))
            if m: days[int(m.group(1))] = [code_for(c.value) for c in row[5:9]]
    return days, sessions

def parse_events(wb, year, month):
    events = []
    for ws in wb.worksheets:
        start = None
        for row in ws.iter_rows():
            vals = [c.value for c in row]
            if start is None:
                if any(isinstance(v, str) and 'EVENTS' in v.upper() for v in vals): start = 'title'; continue
                if ws.title.lower().startswith('sky') and str(vals[0] or '').strip() == 'Date': start = 'rows'; continue
                continue
            if start == 'title':
                if str(vals[0] or '').strip() == 'Date': start = 'rows'
                continue
            if not vals[0]: 
                if events: break
                continue
            date_txt = str(vals[0]); nums = [int(n) for n in re.findall(r'\d+', date_txt)]
            ds = list(range(nums[0], nums[-1] + 1)) if len(nums) >= 2 else nums
            sess = [str(v or '').strip() in ('✓', '✔') or str(v or '').startswith('✓') for v in vals[4:8]]
            ttl = str(vals[1] or '').strip()
            events.append({'id': f"x-{year}{month:02d}{(ds or [0])[0]:02d}-" + re.sub(r'[^a-z0-9]+', '-', ttl.lower()).strip('-')[:30], 'date': date_txt.strip(), 'days': ds, 'title': str(vals[1] or '').strip(),
                           'title_ar': str(vals[2] or '').strip(), 'how': str(vals[3] or '').strip(),
                           'sessions': sess, 'desc': str(vals[8] or '').strip()})
        if events: break
    return events

def moon_info(year, month, ndays, lat, lon):
    try: import ephem
    except ImportError: return {}
    out = {}
    icons = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘']
    def obs(local):
        o = ephem.Observer(); o.lat, o.lon = str(lat), str(lon); o.pressure = 0
        o.date = ephem.Date(local - dt.timedelta(hours=3)); return o
    for d in range(1, ndays + 1):
        day = dt.date(year, month, d); m = ephem.Moon()
        t22 = dt.datetime.combine(day, dt.time(22)); m.compute(obs(t22)); lit = m.phase
        m2 = ephem.Moon(); m2.compute(obs(t22 + dt.timedelta(days=1))); waxing = m2.phase > lit
        ic = 0 if lit < 3 else 4 if lit > 97 else (1 if lit < 40 else 2 if lit < 60 else 3) if waxing else (7 if lit < 40 else 6 if lit < 60 else 5)
        a, b = dt.datetime.combine(day, dt.time(20, 30)), dt.datetime.combine(day, dt.time(23, 59))
        def up(x): mm = ephem.Moon(); mm.compute(obs(x)); return mm.alt > 0
        ua, ub = up(a), up(b)
        if ua and ub: note = {'en': 'Up all evening', 'ar': 'ظاهر طوال السهرة'}
        elif not ua and not ub: note = {'en': 'Below horizon', 'ar': 'تحت الأفق'}
        else:
            o = obs(a); ev = (o.next_setting if ua else o.next_rising)(ephem.Moon())
            tl = (ephem.Date(ev).datetime() + dt.timedelta(hours=3)).strftime('%I:%M').lstrip('0')
            note = {'en': ('Sets ' if ua else 'Rises ') + tl + ' PM', 'ar': ('يغيب ' if ua else 'يشرق ') + tl + ' م'}
        out[d] = {'icon': icons[ic], 'lit': round(lit), 'note': note}
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx'); ap.add_argument('--resort', required=True)
    ap.add_argument('--month', help='YYYY-MM (auto-detected from the title if omitted)')
    ap.add_argument('--lat', type=float); ap.add_argument('--lon', type=float)
    a = ap.parse_args()
    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    ws = wb['Calendar'] if 'Calendar' in wb.sheetnames else wb.worksheets[0]
    if a.month: year, month = map(int, a.month.split('-'))
    else:
        ym = find_month(ws)
        if not ym: sys.exit('Could not detect month — pass --month YYYY-MM')
        year, month = ym
    days, sessions = parse_v2(ws) if 'Calendar' in wb.sheetnames else parse_classic(ws)
    if not days: sys.exit('No calendar found in the workbook.')
    ndays = (dt.date(year + month // 12, month % 12 + 1, 1) - dt.timedelta(days=1)).day
    reg_path = ROOT / 'data' / 'resorts.json'
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    resort = next((r for r in reg['resorts'] if r['id'] == a.resort), None)
    if not resort: sys.exit(f'Resort "{a.resort}" not found in data/resorts.json — add it there first.')
    lat = a.lat if a.lat is not None else resort.get('lat', 25.5)
    lon = a.lon if a.lon is not None else resort.get('lon', 37.7)
    moon = moon_info(year, month, ndays, lat, lon)
    data = {'resort': a.resort, 'month': f'{year}-{month:02d}', 'sessions': sessions or resort.get('sessions'),
            'days': [{'d': d, 's': days.get(d, ['', '', '', '']), **({'moon': moon[d]} if d in moon else {})} for d in range(1, ndays + 1)],
            'events': parse_events(wb, year, month)}
    out = ROOT / 'data' / a.resort / f'{year}-{month:02d}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():   # keep Arabic texts already written for the same events
        old = {e.get('id'): e for e in json.loads(out.read_text(encoding='utf-8')).get('events', [])}
        for e in data['events']:
            for k in ('desc_ar', 'title_ar'):
                if not e.get(k) and old.get(e['id'], {}).get(k): e[k] = old[e['id']][k]
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    ms = set(resort.get('months', [])); ms.add(data['month']); resort['months'] = sorted(ms)
    reg_path.write_text(json.dumps(reg, ensure_ascii=False, indent=2), encoding='utf-8')
    a_ = sum(x['s'].count('A') for x in data['days']); l_ = sum(x['s'].count('L') for x in data['days'])
    print(f'✓ Saved {out.relative_to(ROOT)}  —  {a_} Arabian Astronomy · {l_} Lunar Night · {len(data["events"])} events')

if __name__ == '__main__': main()
