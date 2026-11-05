# Local Gmap Worker for macOS: turns this Mac into a gmap.scan worker for the
# Local Gmap Worker API service (../../server.mjs, hosted on Railway).
#
# A port of ../../worker/worker.ps1, the Windows worker, which stays as it is.
# Same service, same job types, same results; only the Windows parts differ:
# launchd in place of the Startup shortcut, caffeinate in place of
# SetThreadExecutionState, a uv-made Python under ~/Library/Application Support
# in place of the embeddable Python under %LOCALAPPDATA%.
#
# It asks the service for a Google Maps job, reads the businesses from Google Maps
# on this Mac's own internet line, and posts them back. Only outbound requests:
# nothing to open on the router.
#
# No browser. Maps fills its result list from /search?tbm=map, 20 businesses a
# page, each with its phone, website, address, rating, categories, coordinates
# and place id. This reads those pages directly, one after another, paging with
# the pb offset. The field positions are gosom's ParseSearchResults
# (github.com/gosom/google-maps-scraper, gmaps/multiple.go, MIT) plus the
# place id at 78 (gosom gmaps/entry.go).
#
# The sweep is the service's (strategy.mjs): "<word> in <place>" for every word of
# the keyword's family, then for a Business scan "shop/company in <street>" for
# the streets the first pass found. The words come from the service on every job.
#
# It also takes web.fetch jobs (fetch.py) and linkedin.scrape jobs
# (linkedin_job.py), each in a process of its own, with packages this installs
# into its own Python on first start. Scans work without them. Those scripts
# are the Windows worker's own, run from ../../worker, so a git pull brings
# their fixes to both. test/macos-parity.test.mjs fails when worker.ps1's
# Google request, field positions or limits change and this file does not.
#
# Standard library only: it runs before any package is installed.
import datetime
import fcntl
import gzip
import json
import os
import plistlib
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

APP = Path(__file__).resolve().parent
ROOT = APP.parent
# fetch.py, linkedin_job.py and linkedin_login.py, shared with the Windows worker.
SHARED = ROOT.parent / 'worker'
DATA = Path(os.environ.get('LOCAL_GMAP_WORKER_DATA') or Path.home() / 'Library' / 'Application Support' / 'LocalGmapWorker')
LOG_FILE = DATA / 'worker.log'
DATA.mkdir(parents=True, exist_ok=True)


def log(message):
    line = '[' + time.strftime('%Y-%m-%d %H:%M:%S') + '] ' + message
    print(line, flush=True)
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 5 * 1024 * 1024:
            LOG_FILE.replace(str(LOG_FILE) + '.old')
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def write_text(path, text):
    Path(path).write_text(text, encoding='utf-8')


def read_text(path):
    return Path(path).read_text(encoding='utf-8')


# ---------------------------------------------------------------- autostart

# A launchd agent starts the worker at sign-in, the way the Startup shortcut
# does on Windows. It runs the launcher, which keeps the worker running.
AGENT_LABEL = 'local.gmapworker'
AGENT_FILE = Path.home() / 'Library' / 'LaunchAgents' / (AGENT_LABEL + '.plist')
LAUNCHER = ROOT / 'Start Local Gmap Worker.command'
AUTOSTART_MARK = DATA / 'autostart-configured.txt'


def write_agent():
    AGENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(AGENT_FILE, 'wb') as f:
        plistlib.dump({
            'Label': AGENT_LABEL,
            'ProgramArguments': ['/bin/bash', str(LAUNCHER)],
            'WorkingDirectory': str(ROOT),
            'RunAtLoad': True,
            'StandardOutPath': str(DATA / 'launchd.log'),
            'StandardErrorPath': str(DATA / 'launchd.log'),
        }, f)


def set_autostart(on):
    if on:
        write_agent()
        print('Autostart is on: the worker starts in the background every time you sign in to this Mac.')
        print(f'Agent: {AGENT_FILE}')
    else:
        if AGENT_FILE.exists():
            AGENT_FILE.unlink()
        print('Autostart is off.')
    write_text(AUTOSTART_MARK, 'configured')


# ------------------------------------------------------------------- config

def read_env_file(file):
    out = {}
    if not file.exists():
        return out
    for line in read_text(file).splitlines():
        t = line.strip()
        if not t or t.startswith('#') or '=' not in t:
            continue
        i = t.index('=')
        out[t[:i].strip()] = t[i + 1:].strip().strip('"')
    return out


def default_name():
    try:
        host = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        host = ''
    host = host or socket.gethostname().split('.')[0]
    return 'mac-' + re.sub(r'[^a-z0-9-]', '-', host.lower())


if len(sys.argv) == 3 and sys.argv[1] == '--autostart' and sys.argv[2] in ('on', 'off'):
    set_autostart(sys.argv[2] == 'on')
    sys.exit(0)

Cfg = read_env_file(ROOT / 'worker.env')
Lab = Cfg.get('HUB_URL', '').rstrip('/')
Key = Cfg.get('WORKER_KEY', '')
if not Lab or not Key:
    log('worker.env is missing HUB_URL or WORKER_KEY. Copy worker.env from the service package (GET /api/worker/package) next to this launcher.')
    sys.exit(2)
if not (SHARED / 'fetch.py').exists():
    log(f'{SHARED} is missing: run this from the repository checkout, next to the Windows worker folder.')
    sys.exit(2)
Name = Cfg.get('WORKER_NAME') or default_name()
# Pause between two Google requests. 1 request a second was never refused in testing.
PaceMs = max(0, int(Cfg['GMAP_PACE_MS'])) if Cfg.get('GMAP_PACE_MS') else 500
# WEB_FETCH=off keeps this Mac to Maps scans.
FetchOn = Cfg.get('WEB_FETCH', '').lower() != 'off'
LinkedInPython = Cfg.get('LINKEDIN_PYTHON', '')
LinkedInSession = Cfg.get('LINKEDIN_SESSION', '')
# Space LinkedIn requests on this Mac, including after a restart.
LinkedInPaceMs = max(0, int(Cfg['LINKEDIN_PACE_MS'])) if Cfg.get('LINKEDIN_PACE_MS') else 60000
LinkedInLastFile = DATA / 'linkedin-last-start.txt'
LinkedInStateFile = DATA / 'linkedin-state.json'
LinkedInState = {'state': 'ready', 'until': 0, 'sessionMtimeNs': 0}
if LinkedInStateFile.exists():
    try:
        saved = json.loads(read_text(LinkedInStateFile))
        LinkedInState = {'state': str(saved['state']), 'until': int(saved['until']), 'sessionMtimeNs': int(saved['sessionMtimeNs'])}
    except (OSError, ValueError, KeyError, TypeError):
        log('Could not read LinkedIn state; sign-in may need to be repeated.')
Types = 'gmap.scan'
# Time kept back from the job's deadline to post the result.
PostMarginSec = 60
# After Google refuses this line, claim nothing for this long.
BlockedRestSec = 1800
Page = 20
MaxPages = 15
# Where a search starts before the place's own centre is known. The query text
# places it ("factory in Taman Daya" lands in Johor Bahru from here too).
DefaultCentre = [3.139, 101.6869]

# One worker per Mac: autostart and a double click must not run two.
_lock = open(DATA / 'worker.lock', 'w')
try:
    fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print('The Local Gmap Worker is already running on this Mac.')
    sys.exit(2)

# Enable sign-in startup once on first setup. Disabling it later stays disabled.
if not AUTOSTART_MARK.exists():
    try:
        write_agent()
        write_text(AUTOSTART_MARK, 'configured')
        log('autostart enabled for sign-in to this Mac')
    except OSError as e:
        log(f'could not enable autostart: {e}')

# Downloaded files carry a quarantine mark that makes Gatekeeper ask before each launcher runs.
subprocess.run(['xattr', '-dr', 'com.apple.quarantine', str(ROOT)], capture_output=True)

# "Local Worker v2" on the desktop, made on first start. Later starts only point
# it at this folder again if the folder moved; one the user deleted stays gone.
DesktopLink = Path.home() / 'Desktop' / 'Local Worker v2.command'
DesktopMark = DATA / 'desktop-shortcut.txt'
if not DesktopMark.exists() or DesktopLink.is_symlink():
    try:
        if not DesktopLink.is_symlink() or os.readlink(DesktopLink) != str(LAUNCHER):
            if DesktopLink.is_symlink():
                DesktopLink.unlink()
            if not DesktopLink.exists():
                DesktopLink.symlink_to(LAUNCHER)
                log(f'desktop shortcut: {DesktopLink}')
        write_text(DesktopMark, str(DesktopLink))
    except OSError as e:
        log(f'no desktop shortcut: {e}')

# Keep the Mac awake while a job runs; sleeping mid-scan loses the job.
_caffeinate = None


def stay_awake(on):
    global _caffeinate
    if on and _caffeinate is None:
        try:
            _caffeinate = subprocess.Popen(['caffeinate', '-i', '-w', str(os.getpid())])
        except OSError:
            pass
    elif not on and _caffeinate is not None:
        _caffeinate.terminate()
        _caffeinate.wait()
        _caffeinate = None


# ----------------------------------------------------------------- service

def ssl_context():
    # A standalone Python may not find the system's CA certificates; certifi's are used when present.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_ssl = ssl_context()


class Answer:
    def __init__(self, status, body):
        self.status = status
        self.body = body


# Every request goes through here. The timeout bounds the connect and every
# read, so a line that stalls mid-answer cannot hold a scan past its lease. Any
# HTTP status comes back as an Answer; only a request that got no answer at all
# raises.
def invoke_http(method, uri, headers=None, body=None, timeout_sec=60):
    req = urllib.request.Request(uri, data=body, method=method)
    req.add_header('accept-encoding', 'gzip, deflate')
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    if body is not None:
        req.add_header('content-type', 'application/json; charset=utf-8')
    try:
        resp = urllib.request.urlopen(req, timeout=timeout_sec, context=_ssl)
    except urllib.error.HTTPError as e:
        resp = e
    with resp:
        data = resp.read()
        encoding = (resp.headers.get('content-encoding') or '').lower()
        if encoding == 'gzip':
            data = gzip.decompress(data)
        elif encoding == 'deflate':
            data = zlib.decompress(data)
        return Answer(resp.status, data.decode('utf-8', errors='replace'))


def invoke_hub(method, path, body=None, timeout_sec=60):
    data = None if body is None else json.dumps(body, separators=(',', ':')).encode('utf-8')
    return invoke_http(method, Lab + path, {'authorization': 'Bearer ' + Key}, data, timeout_sec)


JobId = None
LastBeat = time.monotonic()


def send_beat():
    global LastBeat
    if time.monotonic() - LastBeat < 30:
        return
    LastBeat = time.monotonic()
    try:
        invoke_hub('POST', '/api/jobs/heartbeat', {'worker': Name, 'types': Types.split(','), 'jobId': JobId}, 20)
    except Exception:
        pass


# ------------------------------------------------------------- google maps

# One element of Google's nested arrays, or None.
def at(value, path):
    for i in path:
        if not isinstance(value, list) or i >= len(value):
            return None
        value = value[i]
    return value


def get_pb(lat, lon, offset):
    return ('!4m12!1m3!1d3826.902183192154!2d' + f'{lon:.4f}' + '!3d' + f'{lat:.4f}' +
            '!2m3!1f0!2f0!3f0!3m2!1i600!2i800!4f15.0!7i' + str(Page) + '!8i' + str(offset) +
            '!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0' +
            '!96b1!19m4!2m3!1i360!2i120!4i8')


def text(value):
    if value is None or value == '':
        return None
    return value if isinstance(value, str) else str(value)


Requests = 0
Blocked = None
UserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'


# One page of one search: up to 20 businesses.
def get_list_page(query, lat, lon, offset):
    global Requests, Blocked
    url = ('https://www.google.com/search?tbm=map&authuser=0&hl=en&gl=my&q=' + urllib.parse.quote(query, safe='') +
           '&pb=' + urllib.parse.quote(get_pb(lat, lon, offset), safe=''))
    Requests += 1
    r = invoke_http('GET', url, {'user-agent': UserAgent, 'accept-language': 'en'}, None, 30)
    if r.status in (429, 403):
        Blocked = f'Google refused this line (HTTP {r.status})'
        return []
    if r.status != 200:
        raise RuntimeError(f'Google answered HTTP {r.status}')
    body = r.body
    if re.search(r'unusual traffic|/sorry/index|recaptcha', body, re.I):
        Blocked = 'Google asked this line for a captcha'
        return []
    data = json.loads(body[body.index('\n') + 1:])
    items = at(data, [0, 1])
    rows = []
    if items is None:
        return []
    # From 0: a query that matches one place puts that place at 0; a list starts with a header, which has no name and is skipped below.
    for item in items:
        b = at(item, [14])
        if b is None:
            continue
        name = text(at(b, [11]))
        if not name:
            continue
        parts = at(b, [2])
        rating = at(b, [4, 7])
        reviews = at(b, [4, 8])
        place_id = text(at(b, [78]))
        rows.append({
            'name': name,
            'rating': float(rating) if rating is not None else None,
            'reviews': int(reviews) if reviews is not None else None,
            'category': text(at(b, [13, 0])),
            'address': ', '.join('' if p is None else str(p) for p in parts) if isinstance(parts, list) and parts else None,
            'phone': text(at(b, [178, 0, 0])),
            'website': text(at(b, [7, 0])),
            'mapsUrl': 'https://www.google.com/maps/place/?q=place_id:' + place_id if place_id else None,
            'place_id': place_id,
            'latitude': at(b, [9, 2]),
            'longitude': at(b, [9, 3]),
        })
    return rows


# ------------------------------------------------------------------- sweep

def squash(value):
    return re.sub(r'[^a-z0-9]', '', value.lower())


# The names an address must carry to be in the place: the first comma segment,
# split on "/".
def get_area_names(place):
    return [n for n in (squash(s) for s in place.split(',')[0].split('/')) if len(n) >= 3]


def test_in_area(address, names):
    if not names:
        return True
    a = squash(address or '')
    return any(n in a for n in names)


Found = {}
InArea = 0


# Every page of one search, until a short page, the page cap, `max` in-area
# places, the deadline, or Google refusing. Returns how many places were new.
def search_all(query, centre, names, max_, deadline):
    global InArea
    added = 0
    for p in range(MaxPages):
        if Blocked or time.time() >= deadline or InArea >= max_:
            break
        send_beat()
        rows = None
        for attempt in (1, 2):
            try:
                rows = get_list_page(query, centre[0], centre[1], p * Page)
                break
            except Exception as e:
                log(f"  '{query}' page {p} failed ({e}); " + ('trying again' if attempt == 1 else 'skipping the rest of this search'))
        if rows is None:
            break
        for row in rows:
            key = row['place_id'] or (row['name'] + '|' + (row['address'] or ''))
            if key in Found:
                continue
            Found[key] = row
            added += 1
            if test_in_area(row['address'], names):
                InArea += 1
        if len(rows) < Page:
            break
        if PaceMs:
            time.sleep(PaceMs / 1000)
    return added


def get_median(values):
    v = sorted(float(x) for x in values if x is not None)
    if not v:
        return None
    return v[len(v) // 2]


# The streets named in these addresses, most businesses first.
def get_streets(businesses):
    counts = {}
    names = {}
    for b in businesses:
        for part in (b['address'] or '').split(','):
            m = re.match(r'^\s*(?:jalan|jln\.?)\s+(.+?)\s*$', part, re.I)
            if not m:
                continue
            s = m.group(1)
            if len(s) > 40 or re.search(r'[^\x20-\x7e]|\b\d{5}\b|\bjalan\b|\bjln\b', s, re.I):
                continue
            street = 'Jalan ' + re.sub(r'\s+', ' ', s)
            k = squash(street)
            counts[k] = counts.get(k, 0) + 1
            names[k] = street
    return [names[k] for k in sorted(counts, key=lambda k: -counts[k])]


def to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def invoke_scan(job, strategy):
    global Requests, Blocked, Found, InArea
    started = time.time()
    p = job.get('payload') or {}
    location_only = p.get('searchMode') == 'location_only'
    keyword = '' if location_only else str(p.get('keyword') or '').strip()
    if location_only:
        place = str(p.get('originalPlace') or p.get('place') or p.get('keyword') or '').strip()
    else:
        place = str(p.get('place') or '').strip()
    if not keyword and not place:
        raise RuntimeError('gmap.scan needs a keyword or place')
    max_ = to_int(p.get('max')) if to_int(p.get('max')) > 0 else to_int(strategy['defaultMax'])
    timeout_sec = max(120, to_int(job.get('timeoutMs')) // 1000)
    deadline = started + max(60, timeout_sec - PostMarginSec)
    Requests = 0
    Blocked = None
    Found = {}
    InArea = 0

    family = None
    if place:
        fam = strategy['families'].get(keyword.lower()) if keyword else strategy['families'].get('business')
        if fam:
            family = list(fam)
    names = get_area_names(place) if family else []
    centre = DefaultCentre
    swept = []
    streets = None

    if family:
        query = f'{keyword} in {place}' if keyword else place
        searches = 0
        for word in family:
            if Blocked or time.time() >= deadline or InArea >= max_:
                break
            q = f'{word} in {place}'
            added = search_all(q, centre, names, max_, deadline)
            searches += 1
            swept.append({'keyword': word, 'added': added})
            # After the first search, pin the rest to the place's own centre.
            if searches == 1:
                here = [b for b in Found.values() if test_in_area(b['address'], names)]
                lat = get_median(b['latitude'] for b in here)
                lng = get_median(b['longitude'] for b in here)
                if lat is not None and lng is not None:
                    centre = [lat, lng]
                log(f"  map centre of {place}: {','.join(str(c) for c in centre)}")
            log(f"  '{q}': +{added} (in {place} so far: {InArea}, requests: {Requests})")
        # Business only: street by street, two searches a street.
        if (keyword == '' or keyword.lower() == 'business') and not Blocked and InArea < max_ and time.time() < deadline:
            street_list = get_streets([b for b in Found.values() if test_in_area(b['address'], names)])
            streets = {'total': len(street_list), 'searched': 0, 'added': 0}
            log(f'  streets: {len(street_list)}')
            for street in street_list:
                if Blocked or time.time() >= deadline or InArea >= max_:
                    break
                for form in strategy['streetForms']:
                    streets['added'] += search_all(f'{form} in {street}, {place}', centre, names, max_, deadline)
                streets['searched'] += 1
            log(f"  streets searched: {streets['searched']} of {streets['total']}, +{streets['added']}")
    else:
        query = f'{keyword} in {place}' if place else keyword
        search_all(query, centre, names, max_, deadline)

    all_rows = list(Found.values())
    kept = all_rows
    outside = 0
    if family and names:
        inside = [b for b in all_rows if test_in_area(b['address'], names)]
        # Below this share the place name is not how addresses are written there: keep everything.
        if len(inside) >= len(all_rows) * float(strategy['areaMatchFloor']):
            kept = inside
            outside = len(all_rows) - len(inside)
    businesses = [{k: v for k, v in b.items() if k not in ('latitude', 'longitude')} for b in kept[:max_]]
    if not businesses and Blocked:
        raise RuntimeError(f'{Blocked} before any business was read')
    if family and not businesses:
        raise RuntimeError(f'no businesses found for {query}')
    return {
        'query': query, 'keyword': keyword, 'place': place or None,
        'businesses': businesses, 'found': len(businesses), 'capped': len(businesses) >= max_,
        'blocked': False, 'blockedReason': None, 'limitedView': False,
        'categories': swept or None,
        'outsideArea': outside, 'streets': streets, 'skippedSearches': None, 'scrolls': 0,
        'provider': 'maps-list-local', 'worker': Name,
        'mapCentre': ','.join(str(float(c)) for c in centre),
        'googleRequests': Requests,
        'stoppedEarly': Blocked,
        'tookMs': int((time.time() - started) * 1000), 'at': iso_now(),
    }


# ---------------------------------------------------------------- web pages

# The worker's own Python: the venv start.sh made, which this runs in.
PyExe = sys.executable
PyDir = Path(sys.prefix)
if not LinkedInPython:
    LinkedInPython = PyExe
if not LinkedInSession:
    LinkedInSession = str(DATA / 'linkedin_session.json')
LinkedInStamp = DATA / 'linkedin-installed.txt'
LinkedInReady = False
NextLinkedInSetup = time.time()
LoginAttempted = False
# Pinned: fetch.py calls a private Scrapling helper. Changing a version here
# reinstalls on every Mac's next start.
FetchPackages = ['scrapling==0.5', 'curl_cffi==0.17.0', 'markdownify==1.2.3']
FetchStamp = PyDir / 'installed.txt'
FetchReady = False
NextSetup = time.time()
# The PDF reader, on its own, so a failure here leaves web pages working. Without
# its declared dependencies: fetch.py turns pymupdf4llm's layout model off, so
# pymupdf_layout, onnxruntime and networkx are left out. numpy, tabulate and
# psutil are what it still imports.
PdfPackages = ['pymupdf4llm==2.1', 'pymupdf==2.1', 'numpy==2.5.4', 'tabulate==0.10.0', 'psutil==7.2.2']
PdfStamp = PyDir / 'pdf-installed.txt'
PdfReady = False
NextPdfSetup = time.time()
PIP = ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-warn-script-location']


def run(args, what):
    code = subprocess.run(args).returncode
    if code:
        raise RuntimeError(f'{what} exited {code}')


# The fetch packages into this Python, once. False if it failed; the worker
# then takes scans only and tries again in an hour.
def install_fetcher():
    want = ' '.join(FetchPackages)
    if FetchStamp.exists() and read_text(FetchStamp).strip() == want:
        return True
    log('setting up page fetching: Scrapling, about 60 MB, once')
    try:
        run([PyExe, *PIP, *FetchPackages], 'pip')
        run([PyExe, '-I', '-c', 'import curl_cffi, markdownify, scrapling.parser, scrapling.core.shell'], 'the import check')
        write_text(FetchStamp, want)
        log('page fetching is ready')
        return True
    except Exception as e:
        log(f'page fetching is off for now: setup failed ({e}). Trying again in an hour.')
        return False


# pymupdf4llm into the same Python, once page fetching works. Until then a PDF
# job fails with "still being set up".
def install_pdf_reader():
    want = ' '.join(PdfPackages)
    if PdfStamp.exists() and read_text(PdfStamp).strip() == want:
        return True
    log('setting up PDF reading: PyMuPDF, about 160 MB, once')
    try:
        run([PyExe, *PIP, '--no-deps', *PdfPackages], 'pip')
        run([PyExe, '-I', '-c', 'import pymupdf, pymupdf4llm'], 'the import check')
        write_text(PdfStamp, want)
        log('PDF reading is ready')
        return True
    except Exception as e:
        log(f'PDF reading is off for now: setup failed ({e}). Trying again in an hour.')
        return False


# Install the scraper and browser into the worker's own Python. A custom Python
# can still be supplied in worker.env.
def install_linkedin():
    want = f'{LinkedInPython} linkedin-scraper==3.1.2 playwright-chromium-v1'
    if os.path.exists(LinkedInPython) and LinkedInStamp.exists() and read_text(LinkedInStamp).strip() == want:
        return True
    try:
        log('setting up LinkedIn: installing scraper and Chromium (first start only)')
        run([LinkedInPython, *PIP, 'linkedin-scraper==3.1.2'], 'pip')
        run([LinkedInPython, '-m', 'playwright', 'install', 'chromium'], 'browser installation')
        run([LinkedInPython, '-c', 'from linkedin_scraper import BrowserManager, PersonScraper, CompanyScraper'], 'the import check')
        write_text(LinkedInStamp, want)
        log('LinkedIn scraper is installed')
        return True
    except Exception as e:
        log(f'LinkedIn setup failed: {e}. Trying again in an hour.')
        return False


# Run one job script in its own process; it gets the payload in a file and
# prints one JSON line. The answer is the last line: a library that prints to
# stdout must not break it.
def run_job_script(args, timeout_ms, env=None, timeout_message='the job timed out'):
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout_ms / 1000, env=env)
    except subprocess.TimeoutExpired:
        raise RuntimeError(timeout_message)
    lines = proc.stdout.decode('utf-8', errors='replace').strip().splitlines()
    return (lines[-1] if lines else ''), proc.stderr.decode('utf-8', errors='replace').strip()


# One web.fetch job, by fetch.py.
def invoke_fetch(job):
    p = job.get('payload') or {}
    file = DATA / f"fetch-{job['id']}.json"
    spec = {'url': p.get('url'), 'format': p.get('format'), 'mainContent': p.get('mainContent') is not False, 'timeoutMs': to_int(job.get('timeoutMs'))}
    write_text(file, json.dumps(spec, separators=(',', ':')))
    try:
        timeout_ms = to_int(job.get('timeoutMs'))
        line, err = run_job_script([PyExe, '-I', str(SHARED / 'fetch.py'), str(file)], timeout_ms + 10000,
                                   timeout_message=f'the page took longer than {timeout_ms // 1000} s')
        if not line:
            raise RuntimeError(f'fetch.py answered nothing: {err}')
        r = json.loads(line)
        if not r.get('ok'):
            raise RuntimeError(str(r.get('error')))
        r['result']['worker'] = Name
        return r['result']
    finally:
        file.unlink(missing_ok=True)


# ------------------------------------------------------------------ results

# Post a result, retrying the service for a few minutes. If it never takes it,
# keep a copy on disk rather than lose the scan. The job's payload rides along:
# when a service restart has lost the job, the service files the scan again
# under the same id, so the caller polling it still gets it.
def send_result(id_, payload, ok, result, error_text, retry_after_ms=0, type_='gmap.scan'):
    body = {'worker': Name, 'type': type_, 'ok': ok, 'result': result, 'error': error_text or None, 'payload': payload}
    # Tells the service to stop handing this worker jobs while Google rests it.
    if retry_after_ms:
        body['retryAfterMs'] = retry_after_ms
    for wait in (0, 10, 30, 60, 120):
        time.sleep(wait)
        try:
            r = invoke_hub('POST', f'/api/jobs/{id_}/result', body, 120)
            if r.status == 200:
                return
            # The service has already settled this job (cancelled, or finished elsewhere): a copy would never be taken.
            if r.status == 409:
                log(f'  job {id_} is already settled by the service; not kept')
                return
            log(f'  the service answered HTTP {r.status} to the result: {r.body}')
            if r.status in (400, 403, 404, 409):
                break
        except Exception as e:
            log(f'  could not post the result: {e}')
    folder = DATA / 'unsaved'
    folder.mkdir(parents=True, exist_ok=True)
    write_text(folder / f'{id_}.json', json.dumps(body, indent=2))
    log(f'  result kept at {folder / (id_ + ".json")}')


# Offer the service every kept scan, once per start: one kept while the service
# was down is saved when it is back. A scan the service takes moves to
# unsaved/sent; one it refuses stays, with the reason in the log.
Offered = set()


def send_unsaved():
    folder = DATA / 'unsaved'
    if not folder.exists():
        return
    for file in sorted(folder.glob('*.json')):
        if file.name in Offered:
            continue
        Offered.add(file.name)
        try:
            r = invoke_http('POST', f'{Lab}/api/jobs/{file.stem}/result', {'authorization': 'Bearer ' + Key}, file.read_bytes(), 120)
            if r.status == 200:
                sent = folder / 'sent'
                sent.mkdir(exist_ok=True)
                file.replace(sent / file.name)
                log(f'kept result {file.stem} saved by the service')
            else:
                log(f'kept result {file.stem}: the service answered HTTP {r.status}: {r.body}')
        except Exception as e:
            log(f'kept result {file.stem} not sent: {e}')


# ----------------------------------------------------------------- linkedin

def now_ms():
    return int(time.time() * 1000)


def session_mtime_ns():
    try:
        return os.stat(LinkedInSession).st_mtime_ns
    except OSError:
        return None


def run_linkedin_job(job):
    global JobId
    file = DATA / f"linkedin-{job['id']}.json"
    pace_start = time.time()
    waited_ms = 0
    try:
        last_ms = 0
        if LinkedInLastFile.exists():
            try:
                last_ms = int(read_text(LinkedInLastFile).strip())
            except ValueError:
                pass
        if last_ms > 0:
            next_ms = last_ms + LinkedInPaceMs
            while now_ms() < next_ms:
                send_beat()
                time.sleep(1)
        waited_ms = int((time.time() - pace_start) * 1000)
        write_text(LinkedInLastFile, str(now_ms()))
        write_text(file, json.dumps(job.get('payload'), separators=(',', ':')))
        line, err = run_job_script([LinkedInPython, str(SHARED / 'linkedin_job.py'), str(file)], to_int(job.get('timeoutMs')),
                                   env={**os.environ, 'LINKEDIN_SESSION': LinkedInSession}, timeout_message='LinkedIn job timed out')
        if not line:
            raise RuntimeError(f'LinkedIn scraper returned no result: {err}')
        answer = json.loads(line)
        if not answer.get('ok'):
            raise RuntimeError(str(answer.get('error')))
        answer['result']['worker'] = Name
        answer['result']['waitedMs'] = waited_ms
        send_result(job['id'], job.get('payload'), True, answer['result'], '', 0, 'linkedin.scrape')
    except Exception as e:
        log(f"LinkedIn job {job['id']} failed: {e}")
        message = str(e)
        retry = 0
        if message.startswith('rate_limited:'):
            retry = 1800000
            LinkedInState['state'] = 'rate_limited'
            LinkedInState['until'] = now_ms() + retry
        elif message.startswith('session_expired:'):
            LinkedInState['state'] = 'session_expired'
            LinkedInState['sessionMtimeNs'] = session_mtime_ns() or LinkedInState['sessionMtimeNs']
        if LinkedInState['state'] != 'ready':
            write_text(LinkedInStateFile, json.dumps(LinkedInState, separators=(',', ':')))
        send_result(job['id'], job.get('payload'), False, None, f'{message} (waitedMs={waited_ms})', retry, 'linkedin.scrape')
    finally:
        file.unlink(missing_ok=True)
        JobId = None


# --------------------------------------------------------------------- main

def main():
    global FetchReady, NextSetup, PdfReady, NextPdfSetup, LinkedInReady, NextLinkedInSetup, LoginAttempted
    global Types, JobId, LastBeat
    log(f"Local Gmap Worker '{Name}' -> {Lab} (Google Maps list pages, {PaceMs} ms apart; web pages {'on' if FetchOn else 'off'})")
    backoff = 5
    # While Google rests this line, take only web.fetch jobs, or nothing.
    rest_until = time.time()
    while True:
        try:
            send_unsaved()
            if FetchOn and not FetchReady and time.time() >= NextSetup:
                FetchReady = install_fetcher()
                NextSetup = time.time() + 3600
            if FetchReady and not PdfReady and time.time() >= NextPdfSetup:
                PdfReady = install_pdf_reader()
                NextPdfSetup = time.time() + 3600
            if FetchReady and not LinkedInReady and time.time() >= NextLinkedInSetup:
                LinkedInReady = install_linkedin()
                NextLinkedInSetup = time.time() + 3600
            if LinkedInReady and not os.path.exists(LinkedInSession) and not LoginAttempted:
                LoginAttempted = True
                log('LinkedIn login: sign in in the browser window, then wait for your feed.')
                code = subprocess.run([LinkedInPython, str(SHARED / 'linkedin_login.py'), LinkedInSession]).returncode
                if code or not os.path.exists(LinkedInSession):
                    log('LinkedIn login was not completed. Restart the worker to try again.')
                else:
                    log('LinkedIn login saved.')
            resting = time.time() < rest_until
            mtime = session_mtime_ns()
            if LinkedInState['state'] == 'session_expired' and mtime is not None and mtime > LinkedInState['sessionMtimeNs']:
                LinkedInState['state'] = 'ready'
                LinkedInState['until'] = 0
            if LinkedInState['state'] == 'rate_limited' and now_ms() >= LinkedInState['until']:
                LinkedInState['state'] = 'ready'
                LinkedInState['until'] = 0
            Types = ','.join(t for t in (
                'gmap.scan' if not resting else None,
                'web.fetch' if FetchReady else None,
                'linkedin.scrape' if LinkedInReady and os.path.exists(LinkedInSession) and LinkedInState['state'] == 'ready' else None,
            ) if t)
            if not Types:
                time.sleep(max(1, int(rest_until - time.time())))
                continue
            r = invoke_hub('GET', f"/api/jobs/next?worker={urllib.parse.quote(Name, safe='')}&types={Types}&wait=25"
                                  f"&linkedinState={LinkedInState['state']}&linkedinCoolUntil={LinkedInState['until']}", None, 45)
            if r.status == 204:
                backoff = 5
                continue
            if r.status in (401, 403):
                log(f"the service refused this worker's key (HTTP {r.status}). Its API_KEY was probably rotated; download the package again (GET /api/worker/package). Retrying in 10 minutes.")
                time.sleep(600)
                continue
            if r.status != 200:
                raise RuntimeError(f'the service answered HTTP {r.status}: {r.body}')
            backoff = 5
            job = json.loads(r.body)['job']
            JobId = job['id']
            LastBeat = time.monotonic() - 60
            payload = job.get('payload') or {}
            if job.get('type') == 'linkedin.scrape':
                run_linkedin_job(job)
                continue
            if job.get('type') == 'web.fetch':
                log(f"job {job['id']}: fetch {payload.get('url')}")
                try:
                    result = invoke_fetch(job)
                    log(f"job {job['id']}: HTTP {result.get('status')}, {result.get('length')} characters of {result.get('format')} in {result.get('tookMs')} ms")
                    send_result(job['id'], job.get('payload'), True, result, '', 0, 'web.fetch')
                except Exception as e:
                    log(f"job {job['id']} failed: {e}")
                    send_result(job['id'], job.get('payload'), False, None, str(e), 0, 'web.fetch')
                finally:
                    JobId = None
                continue
            log(f"job {job['id']}: {payload.get('keyword')} in {payload.get('place')} (max {payload.get('max')})")
            stay_awake(True)
            rest = 0
            try:
                sr = invoke_hub('GET', '/api/worker/strategy')
                if sr.status != 200:
                    raise RuntimeError(f'the service gave no sweep strategy (HTTP {sr.status})')
                result = invoke_scan(job, json.loads(sr.body))
                if result['stoppedEarly']:
                    rest = BlockedRestSec
                    log(f"  stopped early: {result['stoppedEarly']}")
                log(f"job {job['id']}: {result['found']} businesses from {result['googleRequests']} Google requests in {round(result['tookMs'] / 60000, 1)} min")
                send_result(job['id'], job.get('payload'), True, result, '', rest * 1000)
            except Exception as e:
                if Blocked:
                    rest = BlockedRestSec
                log(f"job {job['id']} failed: {e}")
                send_result(job['id'], job.get('payload'), False, None, str(e), rest * 1000)
            finally:
                stay_awake(False)
                JobId = None
            if rest:
                log(f"no Maps jobs for {round(rest / 60)} min: Google refused this line" + ('. Still taking web pages.' if FetchReady else ''))
                rest_until = time.time() + rest
        except Exception as e:
            log(f'service unreachable or error: {e}. Retrying in {backoff} s.')
            time.sleep(backoff)
            backoff = min(60, backoff * 2)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        # Ctrl+C in the Terminal window: stop, and tell the launcher not to restart.
        stay_awake(False)
        log('stopped')
        sys.exit(2)
