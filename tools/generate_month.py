#!/usr/bin/env python3
"""
توليد جداول الإتاحة تلقائياً لكل المنتجعات.
Auto-generate availability months for every resort in data/resorts.json.

    python tools/generate_month.py                 # current month + next 2 (only months that don't exist yet)
    python tools/generate_month.py --ahead 5       # current month + next 5
    python tools/generate_month.py --month 2027-03 # one specific month
    python tools/generate_month.py --month 2027-03 --force   # rebuild even if it exists

Manual changes live in data/<resort>/<YYYY-MM>.edits.json and are NEVER touched by this script.
"""
import argparse, datetime as dt, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from astro_core import build_month

ROOT = Path(__file__).resolve().parent.parent

def months_from(start, n):
    y, m = start
    for _ in range(n):
        yield y, m
        m += 1
        if m > 12: y, m = y + 1, 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--month', help='YYYY-MM')
    ap.add_argument('--ahead', type=int, default=2, help='how many months after the current one')
    ap.add_argument('--resort', help='only this resort id')
    ap.add_argument('--force', action='store_true', help='rebuild months that already exist')
    a = ap.parse_args()
    reg_path = ROOT / 'data' / 'resorts.json'
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    if a.month:
        targets = [tuple(map(int, a.month.split('-')))]
    else:
        now = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=3)
        targets = list(months_from((now.year, now.month), a.ahead + 1))
    changed = 0
    for r in reg['resorts']:
        if a.resort and r['id'] != a.resort: continue
        if r.get('auto') is False: continue
        for y, m in targets:
            ym = f'{y}-{m:02d}'; out = ROOT / 'data' / r['id'] / f'{ym}.json'
            if out.exists() and not a.force:
                print(f'· {r["id"]} {ym} exists – skipped'); continue
            data = build_month(r, y, m)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
            r['months'] = sorted(set(r.get('months', [])) | {ym}); changed += 1
            na = sum(x['s'].count('A') for x in data['days']); nl = sum(x['s'].count('L') for x in data['days'])
            print(f'✓ {r["id"]} {ym}: {na} Arabian · {nl} Lunar · {len(data["events"])} events')
    if changed:
        reg_path.write_text(json.dumps(reg, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'done – {changed} month(s) written')

if __name__ == '__main__': main()
