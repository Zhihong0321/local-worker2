# One site.audit job: an SEO and GEO (generative AI optimization) benchmark of
# one website, read on this PC's own line, like PageSpeed but for search and
# AI answer engines. worker.ps1 (and worker.py on macOS) runs this once per job
# with the job's payload in a JSON file and reads one JSON object from stdout.
#
# This file does the network side: the home page, a small crawl, robots.txt,
# llms.txt, the sitemap, a made-up URL, http and www variants, the TLS
# certificate, the page again as AI bots, and two public entity lookups. It
# turns each page into a plain dict (the page model) and hands it to the rule
# modules next to it, which only read dicts and return checks:
#   audit_ai_access.py  robots.txt and AI bots, llms.txt, noai, firewall
#   audit_content.py    answer-ready structure, citability, JS-only content
#   audit_schema.py     structured data, E-E-A-T trust signals
#   audit_onpage.py     on-page SEO, security headers, crawl and speed
# A check is {id, group, title, status pass|warn|fail|na, score 0-1, weight,
# detail, data}. Scores are weighted means: checks into groups, groups into
# the two headline scores.
#
# Same rule as fetch.py: the URL comes from an API caller and this runs inside
# someone's home or office, so every hop must resolve to a public address.
import datetime
import json
import os
import random
import re
import socket
import ssl
import string
import sys
import time
from urllib.parse import urljoin, urlsplit, urlunsplit

# Run with -I like fetch.py, so this folder is not on the path by itself.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from curl_cffi import requests  # noqa: E402
from scrapling.core.shell import Convertor  # noqa: E402
from scrapling.parser import Selector  # noqa: E402

from fetch import Refused, charset, check, main_part  # noqa: E402
import audit_ai_access as ai  # noqa: E402
import audit_content as content  # noqa: E402
import audit_onpage as onpage  # noqa: E402
import audit_schema as schema  # noqa: E402

MAX_BYTES = 3 * 1024 * 1024
MAX_SMALL = 512 * 1024
MAX_REDIRECTS = 5
MAX_PAGES = 25
MAX_LINK_CHECKS = 25
MAX_SCRIPT_SIZES = 8
# Page text kept in the result for the AI advice step, per page.
MAX_CONTENT = 15000
# A pause between requests to the audited site; this is someone's home line.
PAUSE = 0.25
# Bots the page is fetched again as. Each is one more request to the site.
BOT_TEST = ('GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'CCBot')
SKIP_EXT = re.compile(r'\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|gz|mp4|mp3|webm|mov|css|js|json|xml|txt|docx?|xlsx?|pptx?)$', re.I)
HTML_TYPES = ('', 'text/html', 'application/xhtml+xml')
HTTP_VERSIONS = {1: 'HTTP/1.0', 2: 'HTTP/1.1', 3: 'HTTP/2', 4: 'HTTP/2', 5: 'HTTP/2', 30: 'HTTP/3', 31: 'HTTP/3'}
SITE_PAGES = {
    'about': re.compile(r'about|tentang|company|who-we-are|\u5173\u4e8e|\u95dc\u65bc', re.I),
    'contact': re.compile(r'contact|hubungi|\u8054\u7cfb|\u806f\u7d61', re.I),
    'privacy': re.compile(r'privacy|privasi|pdpa|gdpr|\u9690\u79c1|\u96b1\u79c1', re.I),
}
# How the groups add up to the two headline scores, PageSpeed style.
SEO_GROUPS = {'crawl': 30, 'onpage': 30, 'speed': 15, 'schema': 15, 'security': 10}
GEO_GROUPS = {'ai_access': 30, 'answer': 25, 'trust': 20, 'citability': 15, 'entity': 10}
# Said in every report, so nobody reads a score as covering them.
NOT_CHECKED = [
    'Backlinks and domain authority: needs a paid web-wide link index.',
    'Google rankings, keyword volume and traffic: needs Google Search scraping or paid tools.',
    'Search Console (indexing, clicks): only the site owner can see it.',
    'Whether ChatGPT, Perplexity, Gemini, Claude or AI Overviews actually cite the site: needs paid APIs.',
    'Real-user Core Web Vitals and a full browser render (Lighthouse): not in this version; speed here is the HTML response only.',
]
WIKIDATA = 'https://www.wikidata.org/w/api.php'
CC_COLLECTIONS = 'https://index.commoncrawl.org/collinfo.json'


class Resp:
    def __init__(self, url):
        self.url = url
        self.final_url = url
        self.status = None
        self.headers = {}
        self.body = b''
        self.hops = 0
        self.ttfb_ms = None
        self.total_ms = None
        self.http_version = None
        self.error = None
        self.ctype = ''

    def text(self):
        return self.body.decode(self.encoding or 'utf-8', errors='replace')

    encoding = None


def get(session, url, deadline, ua=None, method='GET', limit=MAX_BYTES, follow=True):
    """One request with our own redirects, each hop checked. Never raises: errors land in .error."""
    out = Resp(url)
    started = time.time()
    headers = {'User-Agent': ua} if ua else None
    try:
        for _ in range(MAX_REDIRECTS + 1):
            check(url)
            left = deadline - time.time()
            if left < 2:
                raise Refused('out of time')
            r = session.request(method, url, headers=headers, allow_redirects=False, stream=True, timeout=min(25, left))
            if out.ttfb_ms is None:
                out.ttfb_ms = int((time.time() - started) * 1000)
            location = r.headers.get('location')
            if follow and r.status_code in (301, 302, 303, 307, 308) and location:
                r.close()
                out.hops += 1
                url = urljoin(url, location)
                continue
            break
        else:
            raise Refused(f'more than {MAX_REDIRECTS} redirects')
        out.final_url = url
        out.status = r.status_code
        out.headers = {k.lower(): v for k, v in r.headers.items()}
        out.ctype = (out.headers.get('content-type') or '').split(';')[0].strip().lower()
        out.http_version = HTTP_VERSIONS.get(getattr(r, 'http_version', None))
        chunks, size = [], 0
        if method != 'HEAD':
            for chunk in r.iter_content():
                chunks.append(chunk)
                size += len(chunk)
                if size >= limit or time.time() > deadline:
                    break
        r.close()
        out.body = b''.join(chunks)[:limit]
        out.encoding = charset(r, out.body[:4096])
    except Refused as e:
        out.error = str(e)
    except Exception as e:  # a dead link is a finding, not a crash
        out.error = f'{type(e).__name__}: {e}'.split('\n')[0][:200]
    out.total_ms = int((time.time() - started) * 1000)
    return out


def host_key(host):
    host = (host or '').lower()
    return host[4:] if host.startswith('www.') else host


def clean_url(url):
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path or '/', parts.query, ''))


def squash(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def words(s):
    return len(re.findall(r'\w+', s or ''))


def tag_of(el):
    return el.tag.lower() if isinstance(el.tag, str) else ''


def in_list(el):
    p = el.getparent()
    while p is not None:
        if tag_of(p) in ('ul', 'ol'):
            return True
        p = p.getparent()
    return False


def read_jsonld(root):
    found, errors = [], 0
    for el in root.xpath('//script[@type]'):
        if 'ld+json' not in (el.get('type') or '').lower():
            continue
        raw = (el.text or '').strip()
        raw = re.sub(r'^\s*(<!--|//\s*<!\[CDATA\[|<!\[CDATA\[)', '', raw)
        raw = re.sub(r'(-->|//\s*\]\]>|\]\]>)\s*$', '', raw).strip()
        if not raw:
            continue
        try:
            found.append(json.loads(raw))
        except ValueError:
            try:  # stray control characters in a hand-written block
                found.append(json.loads(re.sub(r'[\x00-\x1f]', ' ', raw)))
            except ValueError:
                errors += 1
    return found, errors


def build_page(resp, origin_host, script_sizes):
    """The page model the rule modules read. Keys as in the contract; '_' keys are for this file."""
    text = resp.text()
    sel = Selector(content=text, url=resp.final_url)
    root = sel._root
    meta = {}
    for m in root.iter('meta'):
        key = (m.get('name') or m.get('property') or m.get('http-equiv') or '').strip().lower()
        if key and m.get('content') is not None and key not in meta:
            meta[key] = m.get('content').strip()
    title = root.xpath('string(//title)')
    lang = root.xpath('string(//html/@lang)') or None
    canonical = None
    for link in root.xpath('//link[@rel and @href]'):
        if 'canonical' in (link.get('rel') or '').lower().split():
            canonical = urljoin(resp.final_url, link.get('href').strip())
            break
    headings = [{'level': int(tag_of(h)[1]), 'text': squash(h.text_content())}
                for h in root.xpath('//h1|//h2|//h3|//h4|//h5|//h6')]

    all_links = []
    for a in root.xpath('//a[@href]'):
        href = (a.get('href') or '').strip()
        if not href or href.startswith(('#', 'javascript:', 'mailto:', 'tel:', 'data:')):
            continue
        absolute = urljoin(resp.final_url, href)
        if not absolute.startswith(('http://', 'https://')):
            continue
        all_links.append({'href': absolute, 'text': squash(a.text_content())[:200], 'rel': (a.get('rel') or '').lower(),
                          'internal': host_key(urlsplit(absolute).hostname) == origin_host})

    main_sel = main_part(sel)
    main = main_sel._root
    # Markdown of the main content, as fetch.py makes it, for the service's AI advice step.
    try:
        markdown = ''.join(Convertor._extract_content(main_sel, 'markdown', main_content_only=True)).strip()
    except Exception:
        markdown = ''
    sections = [{'heading': None, 'level': 1, 'paragraphs': [], 'lists': 0, 'tables': 0, 'words': 0}]
    paragraphs, n_lists, n_tables = [], 0, 0
    for el in main.iter():
        tag = tag_of(el)
        cur = sections[-1]
        if tag in ('h2', 'h3', 'h4', 'h5', 'h6'):
            sections.append({'heading': squash(el.text_content()), 'level': int(tag[1]), 'paragraphs': [], 'lists': 0, 'tables': 0, 'words': 0})
        elif tag == 'p':
            t = squash(el.text_content())
            if t:
                cur['paragraphs'].append(t)
                cur['words'] += words(t)
                paragraphs.append(t)
        elif tag in ('ul', 'ol') and not in_list(el):
            cur['lists'] += 1
            cur['words'] += words(el.text_content())
            n_lists += 1
        elif tag == 'table':
            cur['tables'] += 1
            cur['words'] += words(el.text_content())
            n_tables += 1
    main_links = []
    for a in main.xpath('.//a[@href]'):
        absolute = (a.get('href') or '').strip()
        if absolute.startswith(('http://', 'https://')):
            main_links.append({'href': absolute, 'text': squash(a.text_content())[:200], 'rel': (a.get('rel') or '').lower(),
                               'internal': host_key(urlsplit(absolute).hostname) == origin_host})
    body_text = squash(main.text_content())

    images = []
    for img in root.iter('img'):
        src = img.get('src') or img.get('data-src') or ''
        images.append({'src': urljoin(resp.final_url, src) if src and not src.startswith('data:') else src,
                       'alt': img.get('alt')})
    jsonld, jsonld_errors = read_jsonld(root)
    scripts, script_bytes, script_srcs = 0, 0, []
    for s in root.iter('script'):
        kind = (s.get('type') or '').lower()
        if 'json' in kind or 'template' in kind:
            continue
        scripts += 1
        if s.get('src'):
            src = urljoin(resp.final_url, s.get('src'))
            script_srcs.append(src)
            script_bytes += script_sizes.get(src) or 0
        else:
            script_bytes += len(s.text or '')
    return {
        'url': resp.final_url, 'status': resp.status, 'headers': resp.headers, 'html_bytes': len(resp.body),
        'title': squash(title) or None, 'meta': meta, 'lang': lang, 'canonical': canonical,
        'headings': headings, 'sections': sections, 'paragraphs': paragraphs, 'lists': n_lists, 'tables': n_tables,
        'text': body_text, 'word_count': words(body_text), 'links': main_links, 'images': images,
        'jsonld': jsonld, 'microdata_types': [t for t in root.xpath('//@itemtype')],
        'time_tags': [t for t in root.xpath('//time/@datetime')],
        'scripts': scripts, 'script_bytes': script_bytes,
        '_all_links': all_links, '_script_srcs': script_srcs, '_jsonld_errors': jsonld_errors, '_markdown': markdown,
    }


def noindex(page):
    robots = ' '.join([page['meta'].get('robots', ''), page['meta'].get('googlebot', ''), page['headers'].get('x-robots-tag', '')]).lower()
    return 'noindex' in robots or re.search(r'\bnone\b', robots) is not None


def cert_days_left(host, deadline):
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=max(1, min(10, deadline - time.time()))) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                not_after = tls.getpeercert().get('notAfter')
        end = datetime.datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), datetime.timezone.utc)
        return (end - datetime.datetime.now(datetime.timezone.utc)).days
    except Exception:
        return None


def read_sitemap(session, url, deadline):
    out = {'found': False, 'url': url, 'urls': 0, 'errors': [], 'lastmod_newest': None, '_locs': []}
    r = get(session, url, deadline, limit=MAX_BYTES)
    if r.error or r.status != 200:
        return out
    body = r.text()
    if url.lower().endswith('.gz') or r.body[:2] == b'\x1f\x8b':
        out['found'] = True
        out['errors'].append('gzipped sitemap: not read')
        return out
    if '<urlset' not in body and '<sitemapindex' not in body:
        return out
    out['found'] = True
    locs = [squash(x) for x in re.findall(r'<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</loc>', body, re.S)]
    if '<sitemapindex' in body and locs:
        # An index: read its first child, which is enough to judge and to find pages.
        child = get(session, locs[0], deadline, limit=MAX_BYTES)
        if child.error or child.status != 200:
            out['errors'].append(f'child sitemap {locs[0]} answered {child.status or child.error}')
            return out
        body = child.text()
        locs = [squash(x) for x in re.findall(r'<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</loc>', body, re.S)]
    if not locs:
        out['errors'].append('no <loc> entries')
    dates = sorted(d.strip() for d in re.findall(r'<lastmod>(.*?)</lastmod>', body, re.S))
    out['urls'] = len(locs)
    out['lastmod_newest'] = dates[-1] if dates else None
    out['_locs'] = locs
    return out


def entity_checks(session, host, deadline):
    """Is the site a known entity (Wikidata, Wikipedia) and in Common Crawl, the corpus most AI models learn from."""
    checks = []
    bare = host_key(host)
    item, wiki = None, None
    variants = [f'{s}://{h}{p}' for s in ('https', 'http') for h in (bare, 'www.' + bare) for p in ('', '/')]
    query = 'haswbstatement:"' + '|'.join('P856=' + v for v in variants) + '"'
    try:
        r = session.get(WIKIDATA, params={'action': 'query', 'list': 'search', 'srsearch': query, 'format': 'json', 'srlimit': 1},
                        timeout=max(1, min(15, deadline - time.time())))
        hits = r.json().get('query', {}).get('search', [])
        if hits:
            item = hits[0]['title']
            e = session.get(WIKIDATA, params={'action': 'wbgetentities', 'ids': item, 'props': 'sitelinks', 'format': 'json'},
                            timeout=max(1, min(15, deadline - time.time()))).json()
            links = e.get('entities', {}).get(item, {}).get('sitelinks', {})
            wiki = sorted(k for k in links if k.endswith('wiki') and k not in ('commonswiki', 'specieswiki'))
        checks.append({'id': 'entity.wikidata', 'group': 'entity', 'title': 'Known entity in Wikidata', 'weight': 2,
                       'status': 'pass' if item else 'fail', 'score': 1.0 if item else 0.0,
                       'detail': f'Wikidata item {item} lists this site as its official website.' if item else
                       'No Wikidata item lists this site as its official website (P856); AI models lean on Wikidata to know who you are.',
                       'data': {'item': item}})
        checks.append({'id': 'entity.wikipedia', 'group': 'entity', 'title': 'Has a Wikipedia article', 'weight': 1,
                       'status': 'pass' if wiki else 'warn', 'score': 1.0 if wiki else 0.0,
                       'detail': f'Wikipedia articles in {len(wiki)} languages.' if wiki else
                       'No Wikipedia article found through Wikidata. Many small businesses have none; it is a strong entity signal when earned.',
                       'data': {'languages': (wiki or [])[:20]}})
    except Exception as e:
        checks.append({'id': 'entity.wikidata', 'group': 'entity', 'title': 'Known entity in Wikidata', 'weight': 2,
                       'status': 'na', 'score': None, 'detail': f'Wikidata did not answer ({type(e).__name__}).', 'data': {}})
    try:
        cols = session.get(CC_COLLECTIONS, timeout=max(1, min(15, deadline - time.time()))).json()
        api = cols[0]['cdx-api']
        r = session.get(api, params={'url': bare, 'matchType': 'domain', 'limit': 5, 'output': 'json'},
                        timeout=max(1, min(25, deadline - time.time())))
        if r.status_code not in (200, 404):  # 404 is the index's "No Captures found"; 503 is just busy
            raise RuntimeError(f'HTTP {r.status_code}')
        captures = [line for line in r.text.splitlines() if line.strip().startswith('{') and 'message' not in line] if r.status_code == 200 else []
        checks.append({'id': 'entity.common_crawl', 'group': 'entity', 'title': 'Present in Common Crawl', 'weight': 2,
                       'status': 'pass' if captures else 'fail', 'score': 1.0 if captures else 0.0,
                       'detail': (f'Found in the latest Common Crawl ({cols[0]["id"]}), the open web copy most AI models are trained on.'
                                  if captures else f'Not found in the latest Common Crawl ({cols[0]["id"]}); check that CCBot is not blocked.'),
                       'data': {'crawl': cols[0]['id'], 'captures': len(captures)}})
    except Exception as e:
        checks.append({'id': 'entity.common_crawl', 'group': 'entity', 'title': 'Present in Common Crawl', 'weight': 2,
                       'status': 'na', 'score': None, 'detail': f'The Common Crawl index did not answer ({type(e).__name__}).', 'data': {}})
    return checks


def safe(fn, *args):
    """A rule bug costs that rule, not the audit."""
    try:
        out = fn(*args)
        return [c for c in (out or []) if isinstance(c, dict) and c.get('id')], None
    except Exception as e:
        return [], f'{getattr(fn, "__module__", "")}.{fn.__name__}: {type(e).__name__}: {e}'[:300]


def verdict(score):
    return 'pass' if score >= 0.9 else 'warn' if score >= 0.5 else 'fail'


def merge(per_page):
    """Page checks from several pages: one check per id, mean score, the worst page's words."""
    merged, order = {}, []
    for url, checks in per_page:
        for c in checks:
            if c['id'] not in merged:
                merged[c['id']] = []
                order.append(c['id'])
            merged[c['id']].append((url, c))
    out = []
    for cid in order:
        rows = merged[cid]
        scored = [(u, c) for u, c in rows if c.get('status') != 'na' and isinstance(c.get('score'), (int, float))]
        if not scored:
            first = dict(rows[0][1])
            first['pages'] = len(rows)
            out.append(first)
            continue
        if len(rows) == 1:
            out.append(dict(scored[0][1], pages=1))
            continue
        mean = sum(float(c['score']) for _, c in scored) / len(scored)
        worst_url, worst = min(scored, key=lambda uc: float(uc[1]['score']))
        passed = sum(1 for _, c in scored if c.get('status') == 'pass')
        c = dict(worst)
        c['score'] = round(mean, 3)
        c['status'] = verdict(mean)
        c['detail'] = f'{passed} of {len(scored)} pages pass. Weakest: {worst_url}: {worst.get("detail", "")}'
        c['pages'] = len(scored)
        c['worstUrl'] = worst_url
        out.append(c)
    return out


def score(checks):
    groups = {}
    for c in checks:
        if c.get('status') == 'na' or not isinstance(c.get('score'), (int, float)):
            continue
        w = float(c.get('weight') or 1.0)
        g = groups.setdefault(c['group'], [0.0, 0.0, 0])
        g[0] += w * max(0.0, min(1.0, float(c['score'])))
        g[1] += w
        g[2] += 1
    out = {}
    for name, (sw, tw, n) in groups.items():
        area = 'seo' if name in SEO_GROUPS else 'geo' if name in GEO_GROUPS else 'other'
        out[name] = {'score': round(100 * sw / tw) if tw else None, 'area': area, 'checks': n}

    def headline(weights):
        used = [(out[g]['score'], w) for g, w in weights.items() if g in out and out[g]['score'] is not None]
        total = sum(w for _, w in used)
        return round(sum(s * w for s, w in used) / total) if total else None
    return {'seo': headline(SEO_GROUPS), 'geo': headline(GEO_GROUPS), 'groups': out}


def audit(job):
    started = time.time()
    url = str(job.get('url') or '').strip()
    max_pages = max(0, min(MAX_PAGES, int(job.get('maxPages') if job.get('maxPages') is not None else 5)))
    bot_test = job.get('botTest', True) is not False
    deadline = started + max(20, int(job.get('timeoutMs') or 180000) / 1000 - 15)
    today = datetime.date.today().isoformat()
    session = requests.Session(impersonate='chrome')
    errors = []

    home = get(session, url, deadline)
    if home.error:
        raise Refused(f'could not read {url}: {home.error}')
    if home.ctype not in HTML_TYPES:
        raise Refused(f'not a web page: {home.final_url} is {home.ctype}')
    final = urlsplit(home.final_url)
    origin = f'{final.scheme}://{final.netloc}'
    site_host = host_key(final.hostname)
    script_sizes = {}

    def pause():
        time.sleep(PAUSE)

    # Script sizes once, from the home page: AI crawlers do not run them, so a page made of them is empty to them.
    probe = build_page(home, site_host, script_sizes)
    for src in probe['_script_srcs'][:MAX_SCRIPT_SIZES]:
        if deadline - time.time() < 60:
            break
        r = get(session, src, deadline, method='HEAD')
        size = r.headers.get('content-length')
        script_sizes[src] = int(size) if size and size.isdigit() else 0
    home_page = build_page(home, site_host, script_sizes) if script_sizes else probe

    pause()
    robots = get(session, origin + '/robots.txt', deadline, limit=MAX_SMALL)
    robots_text = robots.text() if robots.status == 200 and not robots.error and 'html' not in robots.ctype else None
    pause()
    llms = get(session, origin + '/llms.txt', deadline, limit=MAX_SMALL)
    sitemap_urls = (ai.sitemaps_in(robots_text) if robots_text else []) or [origin + '/sitemap.xml']
    pause()
    sitemap = read_sitemap(session, sitemap_urls[0], deadline)
    pause()
    junk = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
    soft = get(session, f'{origin}/{junk}-not-a-page', deadline, limit=MAX_SMALL)
    http_to_https = None
    if final.scheme == 'https':
        pause()
        plain = get(session, 'http://' + final.netloc + (final.path or '/'), deadline, limit=MAX_SMALL)
        http_to_https = None if plain.error else urlsplit(plain.final_url).scheme == 'https'
    other = final.hostname[4:] if final.hostname.startswith('www.') else 'www.' + final.hostname
    www_consistent = None
    try:
        socket.getaddrinfo(other, 443)
        pause()
        variant = get(session, f'{final.scheme}://{other}/', deadline, limit=MAX_SMALL)
        if not variant.error:
            www_consistent = urlsplit(variant.final_url).hostname == final.hostname
    except OSError:
        pass  # no www (or bare) name at all: nothing to be inconsistent with
    cert = cert_days_left(final.hostname, deadline) if final.scheme == 'https' else None

    # The crawl: the home page's links first, then the sitemap's, breadth first.
    pages = [(home_page, 0)]
    seen = {clean_url(home.final_url), clean_url(url)}
    queue = []

    def enqueue(links, depth):
        for href in links:
            u = clean_url(href)
            p = urlsplit(u)
            if u in seen or host_key(p.hostname) != site_host or SKIP_EXT.search(p.path):
                continue
            seen.add(u)
            queue.append((u, depth))
    enqueue([l['href'] for l in home_page['_all_links']], 1)
    enqueue(sitemap['_locs'][:50], 1)
    while queue and len(pages) <= max_pages and deadline - time.time() > 45:
        u, depth = queue.pop(0)
        pause()
        r = get(session, u, deadline)
        if r.error or r.status != 200 or r.ctype not in HTML_TYPES:
            continue
        try:
            page = build_page(r, site_host, script_sizes)
        except Exception as e:
            errors.append(f'{u}: {type(e).__name__}: {e}'[:200])
            continue
        pages.append((page, depth))
        enqueue([l['href'] for l in page['_all_links']], depth + 1)

    # Links that the crawl did not open: do they work?
    crawled = {clean_url(p['url']) for p, _ in pages}
    to_check, sources = [], {}
    for p, _ in pages:
        for l in p['_all_links']:
            u = clean_url(l['href'])
            if l['internal'] and u not in crawled and u not in sources and not SKIP_EXT.search(urlsplit(u).path):
                sources[u] = p['url']
                to_check.append(u)
    broken, checked = [], len(pages)
    for u in to_check[:MAX_LINK_CHECKS]:
        if deadline - time.time() < 40:
            break
        pause()
        r = get(session, u, deadline, method='HEAD')
        if r.error or (r.status or 0) in (403, 405, 501):
            r = get(session, u, deadline, limit=1024)
        checked += 1
        if r.error or (r.status or 0) >= 400:
            broken.append({'url': u, 'status': r.status, 'from': sources[u]})

    bots = []
    if bot_test and home.status == 200:
        for token in BOT_TEST:
            if deadline - time.time() < 30:
                break
            pause()
            r = get(session, home.final_url, deadline, ua=ai.bot_user_agent(token))
            bots.append({'bot': token, 'status': r.status, 'bytes': len(r.body), 'error': r.error})

    links_home = home_page['_all_links']
    site_pages = {k: any(rx.search(l['href']) or rx.search(l['text']) for l in links_home if l['internal'])
                  for k, rx in SITE_PAGES.items()}
    site = {
        'pages': [{'url': p['url'], 'status': p['status'], 'title': p['title'], 'description': p['meta'].get('description'),
                   'noindex': noindex(p), 'canonical': p['canonical'], 'word_count': p['word_count'], 'depth': d}
                  for p, d in pages],
        'broken_links': broken, 'links_checked': checked,
        'sitemap': {k: v for k, v in sitemap.items() if not k.startswith('_')},
        'soft404': {'status': soft.status},
        'redirects': {'http_to_https': http_to_https, 'hops': home.hops, 'www_consistent': www_consistent},
        'timing': {'ttfb_ms': home.ttfb_ms, 'total_ms': home.total_ms, 'html_bytes': len(home.body),
                   'content_encoding': home.headers.get('content-encoding'), 'cache_control': home.headers.get('cache-control'),
                   'http_version': home.http_version},
    }

    # Rules. Page rules run on every crawled page and are merged; site rules run once.
    per_page = []
    for p, _ in pages:
        checks = []
        for fn, args in ((ai.ai_meta_checks, (p,)), (content.answer_checks, (p,)), (content.citability_checks, (p,)),
                         (content.render_checks, (p,)), (schema.schema_checks, (p,)), (schema.trust_checks, (p, today, site_pages)),
                         (onpage.onpage_checks, (p,))):
            got, err = safe(fn, *args)
            checks += got
            if err and err not in errors:
                errors.append(err)
        per_page.append((p['url'], checks))
    checks = merge(per_page)
    for fn, args in ((ai.robots_checks, (robots.status if not robots.error else None, robots_text, final.path or '/')),
                     (ai.llms_txt_checks, (llms.status if not llms.error else None, llms.text() if llms.status == 200 else None, llms.ctype)),
                     (ai.bot_response_checks, ({'status': home.status, 'bytes': len(home.body)}, bots)),
                     (onpage.security_checks, (home_page, cert)),
                     (onpage.site_checks, (site,))):
        got, err = safe(fn, *args)
        checks += got
        if err:
            errors.append(err)
    if deadline - time.time() > 20:
        checks += entity_checks(session, final.hostname, deadline)
    for c in checks:
        c.setdefault('weight', 1.0)

    return {
        'url': job.get('url'), 'finalUrl': home.final_url, 'status': home.status,
        'scores': score(checks), 'checks': checks,
        # Each page carries its own text and problems, so advice can be asked for later without a new crawl.
        'pages': [{'url': p['url'], 'depth': d, 'title': p['title'], 'words': p['word_count'],
                   'description': p['meta'].get('description'),
                   'headings': [f"h{h['level']} {h['text'][:150]}" for h in p['headings'] if h['level'] <= 3][:40],
                   'content': p['_markdown'][:MAX_CONTENT],
                   'issues': [{'id': c['id'], 'status': c['status'], 'detail': str(c.get('detail', ''))[:300]}
                              for u, cs in per_page if u == p['url'] for c in cs if c.get('status') in ('warn', 'fail')],
                   'scores': score([c for u, cs in per_page if u == p['url'] for c in cs])} for p, d in pages],
        'facts': {
            'robotsTxt': robots.status, 'llmsTxt': llms.status, 'sitemap': site['sitemap'], 'soft404Status': soft.status,
            'httpToHttps': http_to_https, 'wwwConsistent': www_consistent, 'certDaysLeft': cert, 'timing': site['timing'],
            'brokenLinks': broken[:20], 'linksChecked': checked, 'bots': bots, 'sitePages': site_pages,
            'jsonldErrors': home_page['_jsonld_errors'],
        },
        'notChecked': NOT_CHECKED, 'errors': errors, 'provider': 'local-audit',
        'tookMs': int((time.time() - started) * 1000),
    }


if __name__ == '__main__':
    try:
        with open(sys.argv[1], encoding='utf-8') as f:
            result = audit(json.load(f))
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True, default=str))
    except Refused as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=True))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'}, ensure_ascii=True))
