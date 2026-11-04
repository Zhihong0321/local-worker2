# One web.fetch job: read a page on this PC's own line and return it as
# markdown, text or html. worker.ps1 runs this once per job with the job's
# payload in a JSON file and reads one JSON object from stdout.
#
# Scrapling's parts without its browser: curl_cffi with Chrome's TLS and HTTP/2
# fingerprint (what Scrapling's Fetcher uses), Scrapling's Selector, and its
# Convertor for markdown. Fetcher itself is not imported: it pulls in
# patchright, 109 MB of browser driver this never uses.
#
# PDFs go to pymupdf4llm, which writes their tables as markdown tables. The
# worker installs it separately, after the page reader, so a PDF can fail
# with "still being set up" on a PC that has just started.
#
# The URL comes from an API caller and this runs inside someone's home or
# office, so every hop, redirects included, must resolve to a public address.
import contextlib
import ipaddress
import json
import re
import socket
import sys
import time
from copy import deepcopy
from urllib.parse import urljoin, urlsplit

from curl_cffi import requests
from scrapling.core.shell import Convertor
from scrapling.parser import Selector

MAX_BYTES = 5 * 1024 * 1024
# A PDF cut short does not open, so it may be bigger; past this it fails whole.
MAX_PDF_BYTES = 30 * 1024 * 1024
MAX_PDF_PAGES = 300
PDF_BATCH = 5
MAX_REDIRECTS = 5
# Page chrome a reader leaves out, like Jina Reader and Tavily extract do.
CHROME_TAGS = ('nav', 'header', 'footer', 'aside', 'form', 'iframe', 'dialog')
# <main> or <article> stands in for the page only if it holds this share of its text.
MAIN_SHARE = 0.3
TEXT_TYPES = ('text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/xml', 'application/xml')


class Refused(Exception):
    pass


def check(url):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        raise Refused(f'only http and https URLs: {url}')
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise Refused(f'{parts.hostname} does not resolve ({e})')
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split('%')[0])
        if not ip.is_global or ip.is_multicast:
            raise Refused(f'{parts.hostname} is a private or local address ({ip}); workers read only public sites')


def charset(response, head):
    if response.charset_encoding:
        return response.charset_encoding
    m = re.search(rb'<meta[^>]+charset=["\']?([a-zA-Z0-9_-]+)', head, re.I)
    return m.group(1).decode('ascii') if m else 'utf-8'


def text_of(page):
    return len(page.get_all_text(strip=True))


def main_part(page):
    """<main> or <article> when it holds the page's text, else <body>, without the page chrome."""
    body = page.css('body').first or page
    whole = text_of(body) or 1
    for css in ('main', 'article', '[role=main]'):
        found = page.css(css).first
        if found and text_of(found) >= whole * MAIN_SHARE:
            body = found
            break
    root = deepcopy(body._root)
    for element in list(root.iter(*CHROME_TAGS)):
        # An article's own <header> carries its title (Wikipedia's does): keep the title alone.
        h1 = element.find('.//h1') if element.tag == 'header' else None
        if h1 is not None:
            h1.tail = None
            element.getparent().replace(element, h1)
            continue
        element.drop_tree()
    # Links that still work once the markdown leaves the page.
    root.make_links_absolute(page.url, resolve_base_href=True)
    return Selector(root=root, url=page.url)


def is_pdf(ctype, raw):
    return ctype in ('application/pdf', 'application/x-pdf') or raw[:5] == b'%PDF-'


def read_pdf(raw, fmt, deadline):
    """PDF to markdown with pymupdf4llm (tables as markdown tables), or plain text.
    Returns (title, content, cut): cut when pages were left out for the page cap or the deadline."""
    try:
        import pymupdf
        import pymupdf4llm
    except ImportError:
        raise Refused('this worker cannot read PDFs yet: its PDF reader is still being set up')
    try:
        doc = pymupdf.open(stream=raw, filetype='pdf')
    except Exception as e:
        raise Refused(f'the PDF does not open ({e})')
    if doc.needs_pass:
        raise Refused('the PDF is password protected')
    title = ((doc.metadata or {}).get('title') or '').strip() or None
    last = min(doc.page_count, MAX_PDF_PAGES)
    parts, done = [], 0
    # pymupdf4llm prints its notices to stdout, which carries this script's answer.
    with contextlib.redirect_stdout(sys.stderr):
        if fmt == 'text':
            parts = [doc[i].get_text() for i in range(last)]
            done = last
        else:
            # About 1.2 s a page on 2026-11-04: a long PDF stops at the deadline with the pages it has.
            while done < last and time.time() < deadline:
                batch = list(range(done, min(done + PDF_BATCH, last)))
                parts.append(pymupdf4llm.to_markdown(doc, pages=batch))
                done = batch[-1] + 1
    if not done:
        raise Refused('no time left to read the PDF; send a longer timeoutMs')
    return title, '\n\n'.join(parts).strip(), done < doc.page_count


def fetch(job):
    url = str(job.get('url') or '').strip()
    fmt = job.get('format') or 'markdown'
    if fmt not in ('markdown', 'text', 'html'):
        raise Refused(f'format is markdown, text or html, not {fmt}')
    started = time.time()
    deadline = started + max(5, int(job.get('timeoutMs') or 60000) / 1000 - 5)
    session = requests.Session(impersonate='chrome')
    for _ in range(MAX_REDIRECTS + 1):
        check(url)
        r = session.get(url, allow_redirects=False, stream=True, timeout=max(1, deadline - time.time()))
        location = r.headers.get('location')
        if r.status_code in (301, 302, 303, 307, 308) and location:
            r.close()
            url = urljoin(url, location)
            continue
        break
    else:
        raise Refused(f'more than {MAX_REDIRECTS} redirects')

    ctype = (r.headers.get('content-type') or '').split(';')[0].strip().lower()
    limit = MAX_PDF_BYTES if is_pdf(ctype, b'') or url.lower().split('?')[0].endswith('.pdf') else MAX_BYTES
    chunks, size, truncated = [], 0, False
    for chunk in r.iter_content():
        chunks.append(chunk)
        size += len(chunk)
        if size >= limit:
            truncated = True
            break
        if time.time() > deadline:
            raise Refused('the site was too slow to send the page')
    r.close()
    raw = b''.join(chunks)[:limit]
    if r.status_code >= 400:
        raise Refused(f'the site answered HTTP {r.status_code}')

    title = None
    out_fmt = fmt
    if is_pdf(ctype, raw):
        if truncated:
            raise Refused(f'the PDF is over {MAX_PDF_BYTES // (1024 * 1024)} MB')
        title, content, truncated = read_pdf(raw, fmt, deadline)
        out_fmt = 'text' if fmt == 'text' else 'markdown'
    elif ctype in TEXT_TYPES:
        content = raw.decode(charset(r, raw[:4096]), errors='replace')
        out_fmt = 'text'
    elif ctype in ('', 'text/html', 'application/xhtml+xml'):
        text = raw.decode(charset(r, raw[:4096]), errors='replace')
        page = Selector(content=text, url=url)
        title = page.css('title::text').get()
        title = str(title).strip() if title else None
        if job.get('mainContent', True):
            page = main_part(page)
        # _extract_content is Scrapling's own md/txt/html export (scrapling extract). Private,
        # so the worker pins the Scrapling version it installs.
        content = ''.join(Convertor._extract_content(page, fmt, main_content_only=True)).strip()
    else:
        raise Refused(f'not a page: {url} is {ctype}')

    return {
        'url': job.get('url'), 'finalUrl': url, 'status': r.status_code, 'contentType': ctype or None,
        'title': title, 'format': out_fmt, 'content': content,
        'length': len(content), 'truncated': truncated, 'provider': 'scrapling-local',
        'tookMs': int((time.time() - started) * 1000),
    }


if __name__ == '__main__':
    try:
        with open(sys.argv[1], encoding='utf-8') as f:
            result = fetch(json.load(f))
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True))
    except Refused as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=True))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'}, ensure_ascii=True))
