"""
Astronomy engine for the AKUN availability calendar.
Computes, for one resort and one month:
  • which experience each session gets (Lunar Night vs Arabian Astronomy) from the Moon
  • the Moon's phase / illumination / rise-set for each evening
  • sky events that happen during session hours (Moon phases, supermoons, Moon close to
    planets / bright stars, oppositions, planet pairs, solstices & equinoxes, meteor-shower
    peaks, lunar eclipses)
Requires: pip install ephem
"""
import datetime as dt, math, re
import ephem

R2D = 180 / math.pi
MON_EN = ['January','February','March','April','May','June','July','August','September','October','November','December']
MON_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر']
ICONS = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘']

# ---------------------------------------------------------------- site & sessions
class Site:
    def __init__(self, resort):
        self.lat = resort.get('lat', 25.5); self.lon = resort.get('lon', 37.7)
        self.elev = resort.get('elevation', 0); self.tz = resort.get('utc_offset', 3)
        self.sessions = resort['sessions']
        rules = resort.get('rules', {})
        self.lunar_min_illum = rules.get('lunar_min_illum', 30)   # % lit for a Lunar Night
        self.lunar_min_up = rules.get('lunar_min_up', 0.5)         # share of the session the Moon must be up
        self.lunar_min_up_rising = rules.get('lunar_min_up_rising', 0.33)  # …when the Moon is rising during the session
        self.open_days = [d[:3].lower() for d in resort.get('open_days', [])]  # e.g. ['mon','wed','thu','fri']; empty = every day
        self.obj_min_alt = rules.get('object_min_alt', 15)         # deg, for events to count as visible

    def obs(self, local, horizon='0'):
        o = ephem.Observer(); o.lat, o.lon = str(self.lat), str(self.lon); o.elevation = self.elev
        o.pressure = 0; o.horizon = horizon
        o.date = ephem.Date(local - dt.timedelta(hours=self.tz)); return o

    def to_local(self, d): return ephem.Date(d).datetime() + dt.timedelta(hours=self.tz)

def _parse_clock(s, default_suffix):
    m = re.match(r'\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?', s, re.I)
    h, mi, suf = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or default_suffix or 'PM').upper()
    if suf == 'PM' and h != 12: h += 12
    if suf == 'AM' and h == 12: h = 0
    return h, mi

def session_window(day, text):
    """'8:30–9:30 PM' or '11:30 PM–12:00 AM' -> (start, end) local datetimes for the evening of `day`."""
    a, b = re.split(r'\s*[–-]\s*', text.strip())
    suf_b = (re.search(r'(AM|PM)', b, re.I) or re.search(r'(AM|PM)', a, re.I)).group(1)
    suf_a = (re.search(r'(AM|PM)', a, re.I) or [None, suf_b])[1]
    ha, ma = _parse_clock(a, suf_a); hb, mb = _parse_clock(b, suf_b)
    base = dt.datetime.combine(day, dt.time())
    s = base + dt.timedelta(hours=ha, minutes=ma)
    if ha < 12: s += dt.timedelta(days=1)            # after midnight belongs to the same night
    e = base + dt.timedelta(hours=hb, minutes=mb)
    if e <= s: e += dt.timedelta(days=1)
    return s, e

def alt(site, body, t):
    body.compute(site.obs(t)); return body.alt * R2D

# ---------------------------------------------------------------- per-day info
def moon_day(site, day):
    m = ephem.Moon(); s0, _ = session_window(day, site.sessions[0]); _, e1 = session_window(day, site.sessions[-1])
    mid = s0 + (e1 - s0) / 2
    m.compute(site.obs(mid)); lit = m.phase
    m2 = ephem.Moon(); m2.compute(site.obs(mid + dt.timedelta(days=1))); waxing = m2.phase > lit
    ic = 0 if lit < 3 else 4 if lit > 97 else (1 if lit < 40 else 2 if lit < 60 else 3) if waxing else (7 if lit < 40 else 6 if lit < 60 else 5)
    ua, ub = alt(site, ephem.Moon(), s0) > 0, alt(site, ephem.Moon(), e1 - dt.timedelta(minutes=1)) > 0
    if ua and ub: note = {'en': 'Up all evening', 'ar': 'ظاهر طوال السهرة'}
    elif not ua and not ub:
        # may rise and set inside the window (rare) — treat as below horizon
        note = {'en': 'Below horizon', 'ar': 'تحت الأفق'}
    else:
        o = site.obs(s0); ev = (o.next_setting if ua else o.next_rising)(ephem.Moon())
        tl = site.to_local(ev); h12 = tl.strftime('%I:%M').lstrip('0'); pm = tl.hour >= 12
        note = {'en': ('Sets ' if ua else 'Rises ') + h12 + (' PM' if pm else ' AM'),
                'ar': ('يغيب ' if ua else 'يشرق ') + h12 + (' م' if pm else ' ص')}
    return {'icon': ICONS[ic], 'lit': round(lit), 'note': note}

def session_codes(site, day, n=13):
    out = []
    for txt in site.sessions:
        a, b = session_window(day, txt)
        ts = [a + (b - a) * i / (n - 1) for i in range(n)]
        alts = [alt(site, ephem.Moon(), t) for t in ts]
        rising = alts[-1] > alts[0]
        # a rising Moon counts once it has visibly risen (-0.83° = refraction + disc) for a third of the session;
        # a setting Moon must be up for at least half of it
        up = sum(x > (-0.83 if rising else 0) for x in alts)
        need = site.lunar_min_up_rising if rising else site.lunar_min_up
        m = ephem.Moon(); m.compute(site.obs(a + (b - a) / 2))
        out.append('L' if (m.phase >= site.lunar_min_illum and up >= n * need) else 'A')
    return out

# ---------------------------------------------------------------- events
def _evening_of(site, local):
    """A moment after midnight belongs to the previous evening."""
    return (local - dt.timedelta(hours=12)).date()

def _sessions_flags(site, day, test, n=5):
    flags = []
    for txt in site.sessions:
        a, b = session_window(day, txt)
        flags.append(any(test(a + (b - a) * i / (n - 1)) for i in range(n)))
    return flags

def _date_label(year, month, days):
    a, b = days[0], days[-1]
    d0 = dt.date(year, month, a)
    if a == b:
        return {'en': f"{d0:%a}, {MON_EN[month-1][:3]} {a}"}
    d1 = dt.date(year, month, b)
    return {'en': f"{d0:%a}–{d1:%a}, {MON_EN[month-1][:3]} {a}–{b}"}

def _ev(kind, key, year, month, days, title, title_ar, how, sessions, desc, desc_ar):
    lab = _date_label(year, month, days)
    return {'id': f"{kind}-{year}{month:02d}{days[0]:02d}-{key}", 'auto': True, 'date': lab['en'], 'days': days,
            'title': title, 'title_ar': title_ar, 'how': how, 'sessions': sessions, 'desc': desc, 'desc_ar': desc_ar}

PLANETS = [('Mercury', 'عطارد', ephem.Mercury), ('Venus', 'الزهرة', ephem.Venus), ('Mars', 'المريخ', ephem.Mars),
           ('Jupiter', 'المشتري', ephem.Jupiter), ('Saturn', 'زحل', ephem.Saturn)]
OUTER = [('Mars', 'المريخ', ephem.Mars), ('Jupiter', 'المشتري', ephem.Jupiter), ('Saturn', 'زحل', ephem.Saturn),
         ('Uranus', 'أورانوس', ephem.Uranus), ('Neptune', 'نبتون', ephem.Neptune)]
def _fixed(ra, dec):
    b = ephem.FixedBody(); b._ra = ephem.hours(ra); b._dec = ephem.degrees(dec); b._epoch = ephem.J2000; return b
STARS = [('the Pleiades', 'الثريا', lambda: _fixed('3:47:24', '24:07:00')), ('Regulus', 'قلب الأسد', lambda: ephem.star('Regulus')),
         ('Spica', 'السماك الأعزل', lambda: ephem.star('Spica')), ('Antares', 'قلب العقرب', lambda: ephem.star('Antares')),
         ('Aldebaran', 'الدبران', lambda: ephem.star('Aldebaran')), ('the Beehive Cluster', 'عنقود خلية النحل', lambda: _fixed('8:40:24', '19:40:00'))]

# IMO peak solar longitudes (J2000) — dates shift by ~a day year to year, so they are computed
SHOWERS = [
    ('QUA', 283.15, 'Quadrantids', 'الرُّبعيّات', 110, 'best before dawn – few during evening sessions'),
    ('LYR', 32.32, 'Lyrids', 'القيثاريّات', 18, ''),
    ('ETA', 45.5, 'Eta Aquariids', 'إيتا الدلويّات', 50, 'best before dawn'),
    ('SDA', 127.0, 'Southern Delta Aquariids', 'دلتا الدلويّات الجنوبية', 25, ''),
    ('PER', 140.0, 'Perseids', 'البرشاويّات', 100, ''),
    ('DRA', 195.4, 'Draconids', 'التنّينيّات', 10, 'an evening shower – good during sessions'),
    ('STA', 197.0, 'Southern Taurids', 'الثوريّات الجنوبية', 5, 'slow, bright fireballs'),
    ('ORI', 208.0, 'Orionids', 'الجباريّات', 20, ''),
    ('NTA', 230.0, 'Northern Taurids', 'الثوريّات الشمالية', 5, 'slow, bright fireballs'),
    ('LEO', 235.27, 'Leonids', 'الأسديّات', 15, ''),
    ('GEM', 262.2, 'Geminids', 'التوأميّات (الجوزائيّات)', 150, "the year's richest shower"),
    ('URS', 270.7, 'Ursids', 'الدبّيّات', 10, ''),
]

def _sun_lon(t):
    s = ephem.Sun(); s.compute(t)
    return ephem.Ecliptic(ephem.Equatorial(s.a_ra, s.a_dec, epoch=ephem.J2000), epoch=ephem.J2000).lon * R2D

def _when_sun_lon(target, start, end):
    t = ephem.Date(start); e = ephem.Date(end); prev = _sun_lon(t)
    while t < e:
        t2 = ephem.Date(t + 0.5); cur = _sun_lon(t2)
        d1 = (target - prev) % 360; d2 = (target - cur) % 360
        if d2 > d1:  # crossed
            lo, hi = t, t2
            for _ in range(30):
                mid = ephem.Date((lo + hi) / 2)
                if (target - _sun_lon(mid)) % 360 > 180: hi = mid
                else: lo = mid
            return ephem.Date(lo)
        t, prev = t2, cur
    return None

def month_events(site, year, month):
    first = dt.date(year, month, 1)
    ndays = (dt.date(year + month // 12, month % 12 + 1, 1) - first).days
    evs = []
    in_month = lambda d: d.year == year and d.month == month

    # -- Moon phases & supermoons
    t = ephem.Date(dt.datetime(year, month, 1) - dt.timedelta(days=2))
    end = ephem.Date(dt.datetime(year, month, 1) + dt.timedelta(days=ndays + 2))
    for fn, kind in [(ephem.next_new_moon, 'new'), (ephem.next_first_quarter_moon, 'fq'), (ephem.next_full_moon, 'full')]:
        d = fn(t)
        while d < end:
            loc = site.to_local(d); eve = _evening_of(site, loc)
            ndays_ = [x.day for x in (eve, eve + dt.timedelta(days=1)) if in_month(x)]
            if kind == 'new' and ndays_:
                evs.append(_ev('newmoon', 'moon', year, month, ndays_, 'New Moon', 'المحاق', '—', [True]*len(site.sessions),
                    'The darkest nights of the month – the best time for galaxies, nebulae and the Milky Way.',
                    'أظلم ليالي الشهر – أفضل وقت لرصد المجرات والسدم ودرب التبانة.'))
            if kind == 'fq':
                eve = loc.date() if loc.hour < 20 else loc.date()
                if in_month(eve):
                    fl = _sessions_flags(site, eve, lambda x: alt(site, ephem.Moon(), x) > site.obj_min_alt)
                    evs.append(_ev('fq', 'moon', year, month, [eve.day], 'First Quarter Moon', 'التربيع الأول', 'Telescope', fl,
                        'Half-lit Moon – the best night to see craters and mountains casting long shadows.',
                        'نصف القمر مضاء – أفضل ليلة لرؤية الفوهات والجبال وظلالها الطويلة.'))
            if kind == 'full':
                m = ephem.Moon(); m.compute(d); km = m.earth_distance * 149597870.7
                # the evening before a pre-dawn full moon is the fuller-looking one; list both evenings
                days = sorted({x.day for x in (eve, eve + dt.timedelta(days=1)) if in_month(x)}) if loc.hour < 12 else [loc.date().day] if in_month(loc.date()) else []
                if days:
                    if km < 360000:
                        evs.append(_ev('full', 'moon', year, month, days, 'Full Moon – Supermoon', 'البدر العملاق', 'Naked eye / telescope', [True]*len(site.sessions),
                            f'A full Moon close to Earth – about {round(km, -2):,.0f} km away – looking slightly bigger and brighter than usual (full at {loc:%I:%M %p} on {MON_EN[loc.month-1][:3]} {loc.day}).'.replace(' 0', ' '),
                            f'بدر قريب من الأرض – على بُعد نحو {round(km, -2):,.0f} كم – يبدو أكبر وألمع من المعتاد.'))
                    else:
                        evs.append(_ev('full', 'moon', year, month, days, 'Full Moon', 'البدر', 'Naked eye / telescope', [True]*len(site.sessions),
                            'The whole Moon lit – bright and beautiful to the eye; the telescope shows the bright ray craters.',
                            'القمر مكتمل الإضاءة – منظر جميل بالعين المجردة، ويُظهر التلسكوب الفوهات الشعاعية اللامعة.'))
            d = fn(ephem.Date(d + 1))

    # -- Moon near planets / bright stars (evening sessions)
    targets = [(n, a, f, 7.0, 'planet') for n, a, f in PLANETS] + [(n, a, f, 4.0, 'star') for n, a, f in STARS]
    for name, ar, f, thr, kind in targets:
        best = []
        for d in range(1, ndays + 1):
            day = dt.date(year, month, d); seps = []
            for txt in site.sessions:
                a, b = session_window(day, txt)
                for i in range(3):
                    tt = a + (b - a) * i / 2; o = site.obs(tt); m = ephem.Moon(); m.compute(o); x = f(); x.compute(o)
                    if m.alt * R2D > site.obj_min_alt and x.alt * R2D > site.obj_min_alt:
                        seps.append(ephem.separation(m, x) * R2D)
            best.append(min(seps) if seps else 99)
        for i, s in enumerate(best):
            if s <= thr and (i == 0 or s <= best[i-1]) and (i == ndays - 1 or s < best[i+1]):
                day = dt.date(year, month, i + 1)
                def near(tt, f=f, thr=thr):
                    o = site.obs(tt); m = ephem.Moon(); m.compute(o); x = f(); x.compute(o)
                    return m.alt * R2D > site.obj_min_alt and x.alt * R2D > site.obj_min_alt and ephem.separation(m, x) * R2D <= thr + 1
                fl = _sessions_flags(site, day, near)
                sep = f'{s:.0f}°' if s >= 1.5 else 'about 1°'
                sep_ar = f'{s:.0f}°' if s >= 1.5 else 'نحو 1°'
                evs.append(_ev('conj', re.sub(r'\W', '', name.lower()), year, month, [i + 1], f'Moon near {name.replace("the ", "")}',
                    f'القمر قرب {ar}', 'Naked eye / binoculars' if kind == 'star' else 'Naked eye / telescope', fl,
                    f'The Moon passes {sep} from {name} – a lovely pairing to the naked eye.',
                    f'يمر القمر على بُعد {sep_ar} من {ar} – منظر جميل بالعين المجردة.'))

    # -- Oppositions (outer planets) and evening greatest elongations (Mercury, Venus)
    for name, ar, f in OUTER:
        el = []
        for d in range(0, ndays + 2):
            b = f(); b.compute(ephem.Date(dt.datetime(year, month, 1) + dt.timedelta(days=d - 1, hours=18))); el.append(abs(b.elong) * R2D)
        for i in range(1, len(el) - 1):
            if el[i] > 178 and el[i] >= el[i-1] and el[i] >= el[i+1]:
                day = dt.date(year, month, 1) + dt.timedelta(days=i - 1)
                if in_month(day):
                    fl = _sessions_flags(site, day, lambda tt, f=f: alt(site, f(), tt) > site.obj_min_alt)
                    evs.append(_ev('opp', name.lower(), year, month, [day.day], f'{name} at Opposition', f'{ar} في التقابل', 'Telescope', fl,
                        f'{name} is at its closest and brightest of the year and visible all night.',
                        f'{ar} في أقرب وألمع حالاته هذا العام، ويُرى طوال الليل.'))
    for name, ar, f in PLANETS[:2]:
        el = []
        for d in range(0, ndays + 2):
            b = f(); b.compute(ephem.Date(dt.datetime(year, month, 1) + dt.timedelta(days=d - 1, hours=15))); el.append(b.elong * R2D)
        for i in range(1, len(el) - 1):
            if el[i] > 15 and el[i] >= el[i-1] and el[i] >= el[i+1]:
                day = dt.date(year, month, 1) + dt.timedelta(days=i - 1)
                if in_month(day):
                    fl = _sessions_flags(site, day, lambda tt, f=f: alt(site, f(), tt) > 5)
                    if any(fl):
                        evs.append(_ev('elong', name.lower(), year, month, [day.day], f'{name} at greatest evening elongation', f'{ar} في أقصى استطالة مسائية',
                            'Naked eye / telescope', fl, f'{name} stands at its farthest from the Sun in the evening sky – look low in the west early in the session.',
                            f'{ar} في أبعد نقطة عن الشمس في سماء المساء – ابحث عنه منخفضاً في الغرب أول الجلسة.'))

    # -- Planet pairs
    pl = PLANETS
    for i in range(len(pl)):
        for j in range(i + 1, len(pl)):
            (n1, a1, f1), (n2, a2, f2) = pl[i], pl[j]; seps = []
            for d in range(1, ndays + 1):
                day = dt.date(year, month, d); best = 99
                for txt in site.sessions:
                    a, b = session_window(day, txt); o = site.obs(a + (b - a) / 2); x, y = f1(), f2(); x.compute(o); y.compute(o)
                    if x.alt * R2D > 10 and y.alt * R2D > 10: best = min(best, ephem.separation(x, y) * R2D)
                seps.append(best)
            for k, s in enumerate(seps):
                if s <= 2.5 and (k == 0 or s <= seps[k-1]) and (k == ndays - 1 or s < seps[k+1]):
                    day = dt.date(year, month, k + 1)
                    fl = _sessions_flags(site, day, lambda tt: alt(site, f1(), tt) > 10 and alt(site, f2(), tt) > 10)
                    evs.append(_ev('pair', f'{n1}{n2}'.lower(), year, month, [k + 1], f'{n1} and {n2} close together', f'اقتران {a1} و{a2}',
                        'Naked eye / telescope', fl, f'{n1} and {n2} appear only {s:.1f}° apart – both fit in a low-power telescope view.',
                        f'يظهر {a1} و{a2} متقاربين بفارق {s:.1f}° فقط.'))

    # -- Solstices & equinoxes
    for fn, en, ar_, de, da in [(ephem.next_solstice, 'Solstice', 'الانقلاب', '', ''), (ephem.next_equinox, 'Equinox', 'الاعتدال', '', '')]:
        d = fn(ephem.Date(dt.datetime(year, month, 1) - dt.timedelta(days=1)))
        loc = site.to_local(d)
        if in_month(loc.date()) or in_month(_evening_of(site, loc)):
            season = {3: ('Spring', 'الربيعي'), 6: ('Summer', 'الصيفي'), 9: ('Autumn', 'الخريفي'), 12: ('Winter', 'الشتوي')}[loc.month]
            eve = _evening_of(site, loc) if loc.hour < 6 else loc.date()
            if not in_month(eve): continue
            flags = []
            for txt in site.sessions:
                a, b = session_window(eve, txt); flags.append(a <= loc < b)
            when = f'{loc:%I:%M %p}'.lstrip('0')
            extra = {'Winter': ('The longest night of the year. ', 'أطول ليلة في السنة. '), 'Summer': ('The shortest night of the year. ', 'أقصر ليلة في السنة. ')}.get(season[0], ('Day and night are nearly equal. ', 'يتساوى الليل والنهار تقريباً. '))
            evs.append(_ev('season', season[0].lower(), year, month, [eve.day], f'{season[0]} {en}', f'{ar_} {season[1]}', '—',
                flags if any(flags) else [True]*len(site.sessions), f'{extra[0]}The exact moment is {when} local time.',
                f'{extra[1]}اللحظة الدقيقة الساعة {when.replace("PM", "م").replace("AM", "ص")} بالتوقيت المحلي.'))

    # -- Meteor showers
    for code, lon, name, ar, zhr, note in SHOWERS:
        pk = _when_sun_lon(lon, dt.datetime(year, month, 1) - dt.timedelta(days=2), dt.datetime(year, month, 1) + dt.timedelta(days=ndays + 1))
        if pk is None: continue
        loc = site.to_local(pk)
        if 6 <= loc.hour < 18:   # daytime peak: the evenings before and after are equally good
            cand = [loc.date() - dt.timedelta(days=1), loc.date()]
        else:
            cand = [_evening_of(site, loc)]
        days = [x.day for x in cand if in_month(x)]
        if not days: continue
        m = ephem.Moon(); m.compute(pk); lit = m.phase
        moon_en = 'little moonlight to spoil the view' if lit < 35 else 'but bright moonlight will hide the fainter meteors'
        moon_ar = 'مع ضوء قمر قليل' if lit < 35 else 'لكن ضوء القمر سيخفي الشهب الخافتة'
        rate = f'up to ~{zhr} meteors per hour under ideal dark skies' if zhr >= 50 else f'a modest {zhr} or so meteors per hour at best'
        rate_ar = f'حتى ~{zhr} شهاباً في الساعة في أفضل الظروف' if zhr >= 50 else f'نحو {zhr} شهاباً في الساعة في أفضل الظروف'
        evs.append(_ev('meteor', code.lower(), year, month, days, f'{name} Meteor Shower (peak)', f'ذروة شهب {ar}',
            'Naked eye', [True]*len(site.sessions), f'{name}: {rate} – {moon_en}.' + (f' Note: {note}.' if note else ''),
            f'شهب {ar}: {rate_ar} – {moon_ar}.'))

    # -- Lunar eclipses
    fm = ephem.next_full_moon(ephem.Date(dt.datetime(year, month, 1) - dt.timedelta(days=1)))
    fulls = []
    while site.to_local(fm).date() <= dt.date(year, month, ndays) + dt.timedelta(days=1):
        fulls.append(fm); fm = ephem.next_full_moon(ephem.Date(fm + 1))
    for d in fulls:
        if not (in_month(site.to_local(d).date()) or in_month(_evening_of(site, site.to_local(d)))): continue
        best = None
        for k in range(-72, 73):
            tt = ephem.Date(d + k * 5 / 1440); m = ephem.Moon(); s = ephem.Sun(); m.compute(tt); s.compute(tt)
            anti = ephem.Equatorial(s.ra + math.pi, -s.dec, epoch=tt)
            sep = ephem.separation((m.ra, m.dec), (anti.ra, anti.dec)) * R2D
            if best is None or sep < best[0]: best = (sep, tt, m.earth_distance * 149597870.7, s.earth_distance, m.radius * R2D, s.radius * R2D)
        sep, tt, km, sun_au, r_m, r_s = best
        pi_m = math.asin(6378.14 / km) * R2D; pi_s = 8.794 / 3600 / sun_au
        umbra = 1.02 * (pi_m - r_s + pi_s); pen = 1.02 * (pi_m + r_s + pi_s)
        kind = 'total' if sep < umbra - r_m else 'partial' if sep < umbra + r_m else 'penumbral' if sep < pen + r_m else None
        if kind:
            loc = site.to_local(tt); eve = _evening_of(site, loc)
            lim = umbra + r_m if kind != 'penumbral' else pen + r_m
            def eclipsed(x):
                t2 = ephem.Date(x - dt.timedelta(hours=site.tz)); m = ephem.Moon(); s = ephem.Sun(); m.compute(t2); s.compute(t2)
                anti = ephem.Equatorial(s.ra + math.pi, -s.dec, epoch=t2)
                return ephem.separation((m.ra, m.dec), (anti.ra, anti.dec)) * R2D < lim and alt(site, ephem.Moon(), x) > 0
            fl = _sessions_flags(site, eve, eclipsed, n=7)
            if any(fl) and in_month(eve):
                en = {'total': 'Total Lunar Eclipse', 'partial': 'Partial Lunar Eclipse', 'penumbral': 'Penumbral Lunar Eclipse'}[kind]
                ar_ = {'total': 'خسوف كلي للقمر', 'partial': 'خسوف جزئي للقمر', 'penumbral': 'خسوف شبه ظلي للقمر'}[kind]
                desc = {'total': 'The Moon slides fully into Earth’s shadow and turns a deep copper-red.',
                        'partial': 'Part of the Moon is covered by Earth’s dark shadow.',
                        'penumbral': 'A subtle shading on one side of the Moon as it passes through Earth’s outer shadow.'}[kind]
                desc_ar = {'total': 'يدخل القمر بالكامل في ظل الأرض ويتحول إلى لون نحاسي أحمر.',
                           'partial': 'يغطي ظل الأرض الداكن جزءاً من القمر.',
                           'penumbral': 'تظليل خفيف على جانب من القمر أثناء مروره في شبه ظل الأرض.'}[kind]
                when = f'{loc:%I:%M %p}'.lstrip('0')
                evs.append(_ev('eclipse', kind, year, month, [eve.day], en, ar_, 'Naked eye / telescope', fl,
                    f'{desc} Greatest eclipse at {when} local time.', f'{desc_ar} ذروة الخسوف الساعة {when.replace("PM", "م").replace("AM", "ص")}.'))

    # de-duplicate (e.g. FQ + Moon-near-X on same evening are both kept) and sort
    seen, out = set(), []
    for e in sorted(evs, key=lambda e: (e['days'][0], e['id'])):
        if e['id'] in seen: continue
        seen.add(e['id']); out.append(e)
    return out

def build_month(resort, year, month):
    site = Site(resort)
    ndays = (dt.date(year + month // 12, month % 12 + 1, 1) - dt.date(year, month, 1)).days
    days = []
    for d in range(1, ndays + 1):
        day = dt.date(year, month, d)
        # every day gets its Moon-based codes; operating days (open_days) are applied by the site,
        # so changing a resort's days in the editor takes effect immediately
        days.append({'d': d, 's': session_codes(site, day), 'moon': moon_day(site, day)})
    events = month_events(site, year, month)
    return {'resort': resort['id'], 'month': f'{year}-{month:02d}', 'sessions': resort['sessions'], 'days': days,
            'events': events, 'generated': True,
            'generated_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')}
