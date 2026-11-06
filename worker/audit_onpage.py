"""SEO and GEO benchmark rules for web page and site audits."""

import collections
import re
import urllib.parse

__all__ = ['onpage_checks', 'security_checks', 'site_checks']


def _chk(id_, grp, title, st, sc, det, data, w=1.0):
    """Build a normalized check result record."""
    return {
        'id': id_, 'group': grp, 'title': title, 'status': st,
        'score': round(sc, 3) if isinstance(sc, (int, float)) else None,
        'weight': float(w), 'detail': det, 'data': data,
    }


def _norm_url(url: str) -> str:
    """Strip trailing slash and URL fragment for canonical comparison."""
    if not url or not isinstance(url, str):
        return ""
    p = urllib.parse.urlsplit(url)
    return f"{p.scheme.lower()}://{p.netloc.lower()}{p.path.rstrip('/')}" + (f"?{p.query}" if p.query else "")


def onpage_checks(page: dict) -> list[dict]:
    """Run SEO onpage checks against a single page model."""
    p = page if isinstance(page, dict) else {}
    m = p.get('meta') if isinstance(p.get('meta'), dict) else {}
    url = p.get('url') if isinstance(p.get('url'), str) else ''
    res = []
    add = lambda i, t, s, sc, d, dt, w=1.0: res.append(_chk(i, 'onpage', t, s, sc, d, dt, w))

    # 1. onpage.title (weight 2)
    t = p.get('title').strip() if isinstance(p.get('title'), str) else ''
    tl = len(t)
    st = 'fail' if not t else ('pass' if 15 <= tl <= 65 else ('warn' if tl <= 80 else 'fail'))
    sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
    det = "Page title missing." if not t else (f"Title optimal ({tl} chars)." if st == 'pass' else f"Title length {tl} outside 15-65.")
    add('onpage.title', 'Page Title Length and Presence', st, sc, det, {'length': tl, 'title': t or None}, 2.0)

    # 2. onpage.description
    d = m.get('description').strip() if isinstance(m.get('description'), str) else ''
    dl = len(d)
    st = 'fail' if not d else ('pass' if 50 <= dl <= 160 else 'warn')
    sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
    det = "Meta description missing." if not d else (f"Description optimal ({dl} chars)." if st == 'pass' else f"Description length {dl} outside 50-160.")
    add('onpage.description', 'Meta Description Presence and Length', st, sc, det, {'length': dl, 'present': bool(d)})

    # 3. onpage.h1 (weight 2)
    h_list = p.get('headings') if isinstance(p.get('headings'), list) else []
    h1s = sum(1 for h in h_list if isinstance(h, dict) and h.get('level') == 1)
    st = 'pass' if h1s == 1 else ('warn' if h1s > 1 else 'fail')
    sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
    det = "Exactly one H1 found." if h1s == 1 else (f"Found {h1s} H1s." if h1s > 1 else "No H1 found.")
    add('onpage.h1', 'Single Primary Heading Present', st, sc, det, {'count': h1s}, 2.0)

    # 4. onpage.image_alt
    imgs = p.get('images') if isinstance(p.get('images'), list) else []
    if not imgs:
        add('onpage.image_alt', 'Image Alternative Text Coverage', 'na', None, "No images found on page.", {'total': 0})
    else:
        alts = sum(1 for i in imgs if isinstance(i, dict) and i.get('alt') is not None)
        ratio = alts / len(imgs)
        st = 'pass' if ratio >= 0.9 else ('warn' if ratio >= 0.6 else 'fail')
        sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
        add('onpage.image_alt', 'Image Alternative Text Coverage', st, sc, f"{round(ratio * 100)}% of images have alt text.",
            {'total': len(imgs), 'with_alt': alts, 'alt_rate': round(ratio, 3)})

    # 5. onpage.thin_content
    wc = p.get('word_count')
    wc = int(wc) if isinstance(wc, (int, float)) else len(str(p.get('text', '')).split())
    st = 'pass' if wc >= 300 else ('warn' if wc >= 100 else 'fail')
    sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
    det = f"Page content has {wc} words." if st == 'pass' else f"Page content is thin ({wc} words)."
    add('onpage.thin_content', 'Main Body Content Word Count', st, sc, det, {'word_count': wc})

    # 6. onpage.lang
    lang = p.get('lang').strip() if isinstance(p.get('lang'), str) else ''
    st, sc = ('pass', 1.0) if lang else ('fail', 0.0)
    add('onpage.lang', 'HTML Document Language Attribute', st, sc,
        f"Document lang is '{lang}'." if lang else "HTML lang attribute is missing.", {'lang': lang or None})

    # 7. onpage.social_cards
    cards = ('og:title', 'og:description', 'og:image', 'twitter:card')
    pres = [k for k in cards if isinstance(m.get(k), str) and m[k].strip()]
    sc = round(len(pres) / 4.0, 2)
    st = 'pass' if sc == 1.0 else ('warn' if sc > 0.0 else 'fail')
    add('onpage.social_cards', 'Social Media Open Graph Tags', st, sc,
        "All social cards present." if st == 'pass' else f"Found {len(pres)} of 4 social card tags.", {'present': pres, 'share': sc})

    # 8. onpage.viewport (weight 2)
    vp = m.get('viewport') if isinstance(m.get('viewport'), str) else ''
    st = 'pass' if 'width=device-width' in vp.lower().replace(' ', '') else ('warn' if vp.strip() else 'fail')
    sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
    det = "Mobile viewport is configured." if st == 'pass' else ("Viewport missing width=device-width." if st == 'warn' else "Mobile viewport meta tag is missing.")
    add('onpage.viewport', 'Mobile Responsive Viewport Meta Tag', st, sc, det, {'viewport': vp.strip() or None}, 2.0)

    # 9. onpage.canonical (weight 2)
    canon = p.get('canonical')
    c_str = canon.strip() if isinstance(canon, str) else ''
    cp = urllib.parse.urlsplit(c_str)
    is_abs = cp.scheme.lower() in ('http', 'https') and bool(cp.netloc)
    is_self = is_abs and _norm_url(c_str) == _norm_url(url)
    st, sc = ('pass', 1.0) if is_self else ('warn', 0.5)
    det = "Canonical matches page target." if is_self else (f"Canonical points to different URL: {c_str}" if c_str else "Canonical link tag is missing.")
    add('onpage.canonical', 'Canonical URL Presence and Target', st, sc, det, {'canonical': c_str or None, 'self_canonical': is_self}, 2.0)

    # 10. onpage.url_hygiene
    if not url:
        st, sc, det, issues, pl = 'fail', 0.0, "Page URL is missing.", ['missing_url'], 0
    else:
        pu = urllib.parse.urlsplit(url)
        path = pu.path or ''
        pl = len(path)
        qp = urllib.parse.parse_qsl(pu.query, keep_blank_values=True)
        issues = [msg for cond, msg in (
            (pl >= 100, f"path length {pl} >= 100"),
            (any(c.isupper() for c in path), "uppercase in path"),
            ('_' in path, "underscores in path"),
            (len(qp) > 2, f"{len(qp)} query params (max 2)"),
        ) if cond]
        st = 'pass' if not issues else ('warn' if len(issues) <= 2 else 'fail')
        sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
        det = "URL structure follows hygiene rules." if st == 'pass' else f"URL issues: {'; '.join(issues)}."
    add('onpage.url_hygiene', 'Clean URL Structure and Parameters', st, sc, det, {'issues': issues, 'path_length': pl})

    return res


def security_checks(page: dict, cert_days_left: int | None = None) -> list[dict]:
    """Run security checks against a single page model and SSL status."""
    p = page if isinstance(page, dict) else {}
    h = p.get('headers') if isinstance(p.get('headers'), dict) else {}
    url = p.get('url') if isinstance(p.get('url'), str) else ''
    is_https = url.lower().startswith('https://')
    res = []
    add = lambda i, t, s, sc, d, dt, w=1.0: res.append(_chk(i, 'security', t, s, sc, d, dt, w))

    # 1. security.https (weight 3)
    st, sc = ('pass', 1.0) if is_https else ('fail', 0.0)
    add('security.https', 'Secure HTTPS Protocol In Use', st, sc,
        "Page served securely over HTTPS." if is_https else "Page is not served over HTTPS.", {'is_https': is_https}, 3.0)

    # 2. security.hsts
    hsts = str(h.get('strict-transport-security', '')).strip()
    m = re.search(r'max-age\s*=\s*(\d+)', hsts, re.IGNORECASE) if hsts else None
    ma = int(m.group(1)) if m else None
    st = 'fail' if not hsts else ('pass' if ma and ma >= 15552000 else 'warn')
    sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
    det = f"HSTS max-age is {ma}s." if ma else ("HSTS header missing valid max-age." if hsts else "HSTS header missing.")
    add('security.hsts', 'HTTP Strict Transport Security Policy', st, sc, det, {'max_age': ma})

    # 3. security.headers
    csp = str(h.get('content-security-policy', '')).strip()
    sec_map = {
        'nosniff': 'nosniff' in str(h.get('x-content-type-options', '')).lower(),
        'csp': bool(csp),
        'xfo': bool(str(h.get('x-frame-options', '')).strip()) or ('frame-ancestors' in csp.lower()),
        'referrer': bool(str(h.get('referrer-policy', '')).strip()),
        'permissions': bool(str(h.get('permissions-policy', '')).strip()),
    }
    cnt = sum(1 for v in sec_map.values() if v)
    sc = round(cnt / 5.0, 2)
    st = 'pass' if sc >= 0.8 else ('warn' if sc >= 0.4 else 'fail')
    add('security.headers', 'Essential HTTP Security Headers', st, sc,
        f"Found {cnt} of 5 essential security headers.", {'present': cnt, 'total': 5, 'details': sec_map})

    # 4. security.mixed_content (weight 2)
    if not is_https:
        add('security.mixed_content', 'HTTPS Mixed Content Resource Check', 'na', None, "Page is not HTTPS; skipped.", {'insecure': []}, 2.0)
    else:
        imgs = p.get('images') if isinstance(p.get('images'), list) else []
        bad = [i.get('src') for i in imgs if isinstance(i, dict) and str(i.get('src', '')).lower().startswith('http://')]
        st, sc = ('fail', 0.0) if bad else ('pass', 1.0)
        det = f"Found {len(bad)} insecure HTTP images." if bad else "No insecure HTTP images found."
        add('security.mixed_content', 'HTTPS Mixed Content Resource Check', st, sc, det, {'insecure_count': len(bad), 'insecure': bad[:10]}, 2.0)

    # 5. security.certificate
    if cert_days_left is None or not isinstance(cert_days_left, (int, float)):
        add('security.certificate', 'SSL TLS Certificate Expiration Window', 'na', None, "No certificate expiration data provided.", {'days_left': None})
    else:
        days = int(cert_days_left)
        st = 'pass' if days >= 30 else ('warn' if days >= 7 else 'fail')
        sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
        det = f"Certificate valid for {days} days." if st == 'pass' else f"Certificate expires in {days} days."
        add('security.certificate', 'SSL TLS Certificate Expiration Window', st, sc, det, {'days_left': days})

    return res


def site_checks(site: dict) -> list[dict]:
    """Run site-wide crawl and speed benchmarks."""
    s = site if isinstance(site, dict) else {}
    pages = s.get('pages') if isinstance(s.get('pages'), list) else []
    tm = s.get('timing') if isinstance(s.get('timing'), dict) else None
    red = s.get('redirects') if isinstance(s.get('redirects'), dict) else None
    sm = s.get('sitemap') if isinstance(s.get('sitemap'), dict) else None
    s404 = s.get('soft404') if isinstance(s.get('soft404'), dict) else None
    res = []
    add = lambda i, g, t, st, sc, d, dt, w=1.0: res.append(_chk(i, g, t, st, sc, d, dt, w))

    # 1. crawl.home_status (weight 3)
    hp = pages[0] if pages and isinstance(pages[0], dict) else None
    st_c = hp.get('status') if hp and isinstance(hp.get('status'), int) else None
    st = 'na' if st_c is None else ('pass' if st_c == 200 else 'fail')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.0)
    add('crawl.home_status', 'crawl', 'Homepage HTTP Status Code', st, sc,
        "Homepage status missing." if st == 'na' else f"Homepage returned HTTP {st_c}.", {'status': st_c}, 3.0)

    # 2. crawl.home_indexable (weight 3)
    nidx = hp.get('noindex') if hp and isinstance(hp.get('noindex'), bool) else None
    st = 'na' if nidx is None else ('pass' if not nidx else 'fail')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.0)
    add('crawl.home_indexable', 'crawl', 'Homepage Search Indexability Status', st, sc,
        "Homepage noindex missing." if st == 'na' else ("Homepage is indexable." if not nidx else "Homepage is noindex."), {'noindex': nidx}, 3.0)

    # 3. crawl.sitemap (weight 2)
    sm_f = sm.get('found') if sm and isinstance(sm.get('found'), bool) else None
    if sm_f is None:
        st, sc, det = 'na', None, "Sitemap data missing."
    elif not sm_f:
        st, sc, det = 'fail', 0.0, "Sitemap was not found."
    else:
        errs = sm.get('errors') if isinstance(sm.get('errors'), list) else []
        urls = sm.get('urls') if isinstance(sm.get('urls'), int) else 0
        st = 'warn' if errs else ('pass' if urls >= 1 else 'warn')
        sc = 1.0 if st == 'pass' else 0.5
        det = f"Sitemap valid with {urls} URLs." if st == 'pass' else f"Sitemap has {len(errs)} errors or 0 URLs."
    add('crawl.sitemap', 'crawl', 'XML Sitemap Presence and Validity', st, sc, det,
        {'found': sm_f, 'urls': sm.get('urls') if sm else None}, 2.0)

    # 4. crawl.broken_links (weight 2)
    chk = s.get('links_checked')
    if chk is None or not isinstance(chk, int) or chk <= 0:
        add('crawl.broken_links', 'crawl', 'Internal and External Broken Links', 'na', None, "No link check data available.", {'checked': 0, 'broken': []}, 2.0)
    else:
        brk = s.get('broken_links') if isinstance(s.get('broken_links'), list) else []
        rate = max(0.0, (chk - len(brk)) / float(chk))
        st = 'pass' if rate == 1.0 else ('warn' if rate >= 0.95 else 'fail')
        sc = 1.0 if st == 'pass' else (0.5 if st == 'warn' else 0.0)
        det = f"All {chk} checked links work." if st == 'pass' else f"{len(brk)} of {chk} links broken ({round(rate * 100, 1)}% work)."
        add('crawl.broken_links', 'crawl', 'Internal and External Broken Links', st, sc, det,
            {'checked': chk, 'broken_count': len(brk), 'working_rate': round(rate, 3), 'broken': brk[:10]}, 2.0)

    # 5. crawl.soft_404
    s4_st = s404.get('status') if s404 and isinstance(s404.get('status'), int) else None
    st = 'na' if s4_st is None else ('pass' if s4_st in (404, 410) else ('fail' if s4_st == 200 else 'warn'))
    sc = 1.0 if st == 'pass' else (None if st == 'na' else (0.5 if st == 'warn' else 0.0))
    add('crawl.soft_404', 'crawl', 'Soft 404 Detection Response', st, sc,
        "Soft 404 test missing." if st == 'na' else f"Missing URL answered HTTP {s4_st}.", {'status': s4_st})

    # 6. crawl.https_redirect (weight 2)
    h2h = red.get('http_to_https') if red and isinstance(red.get('http_to_https'), bool) else None
    st = 'na' if h2h is None else ('pass' if h2h else 'fail')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.0)
    add('crawl.https_redirect', 'crawl', 'HTTP to HTTPS Redirection', st, sc,
        "HTTP redirect missing." if st == 'na' else ("HTTP redirects to HTTPS." if h2h else "HTTP does not redirect to HTTPS."), {'http_to_https': h2h}, 2.0)

    # 7. crawl.redirect_hops
    hops = red.get('hops') if red and isinstance(red.get('hops'), int) else None
    st = 'na' if hops is None else ('pass' if hops in (0, 1) else ('warn' if hops == 2 else 'fail'))
    sc = 1.0 if st == 'pass' else (None if st == 'na' else (0.5 if st == 'warn' else 0.0))
    add('crawl.redirect_hops', 'crawl', 'Redirect Chain Hop Count', st, sc,
        "Redirect hops missing." if st == 'na' else f"Redirect chain has {hops} hop(s).", {'hops': hops})

    # 8. crawl.www_consistent
    wc = red.get('www_consistent') if red and isinstance(red.get('www_consistent'), bool) else None
    st = 'na' if wc is None else ('pass' if wc else 'warn')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.5)
    add('crawl.www_consistent', 'crawl', 'Canonical Hostname Domain Consistency', st, sc,
        "WWW consistency missing." if st == 'na' else ("WWW and non-WWW resolve consistently." if wc else "WWW hosts differ."), {'www_consistent': wc})

    # 9. crawl.duplicate_titles & 10. crawl.duplicate_descriptions
    pairs = (('crawl.duplicate_titles', 'Unique Page Titles Across Site', 'title'),
             ('crawl.duplicate_descriptions', 'Unique Meta Descriptions Across Site', 'description'))
    if len(pages) < 2:
        for cid, title, k in pairs:
            add(cid, 'crawl', title, 'na', None, f"Need >= 2 pages to check {k} uniqueness.", {'pages': len(pages)})
    else:
        for cid, title, k in pairs:
            vals = [p.get(k).strip() for p in pages if isinstance(p, dict) and isinstance(p.get(k), str) and p.get(k).strip()]
            counts = collections.Counter(vals)
            uniq = sum(1 for p in pages if isinstance(p, dict) and isinstance(p.get(k), str) and counts[p.get(k).strip()] == 1)
            sc = round(uniq / float(len(pages)), 3)
            st = 'pass' if sc == 1.0 else ('warn' if sc >= 0.8 else 'fail')
            det = f"All {len(pages)} pages have unique {k}s." if st == 'pass' else f"{uniq} of {len(pages)} pages have unique {k}s."
            add(cid, 'crawl', title, st, sc, det, {'total': len(pages), f'unique_{k}s': uniq, 'rate': sc})

    # 11. crawl.noindex_pages
    if not pages:
        add('crawl.noindex_pages', 'crawl', 'Indexable Pages Crawl Coverage', 'na', None, "No pages crawled.", {'total': 0})
    else:
        idx_cnt = sum(1 for p in pages if isinstance(p, dict) and not p.get('noindex'))
        sc = round(idx_cnt / float(len(pages)), 3)
        st = 'pass' if sc == 1.0 else ('warn' if sc >= 0.8 else 'fail')
        det = f"All {len(pages)} pages indexable." if st == 'pass' else f"{idx_cnt} of {len(pages)} pages indexable."
        add('crawl.noindex_pages', 'crawl', 'Indexable Pages Crawl Coverage', st, sc, det,
            {'total': len(pages), 'indexable': idx_cnt, 'rate': sc})

    # 12. speed.ttfb (weight 2)
    ttfb = tm.get('ttfb_ms') if tm and isinstance(tm.get('ttfb_ms'), int) else None
    st = 'na' if ttfb is None else ('pass' if ttfb <= 800 else ('warn' if ttfb <= 1800 else 'fail'))
    sc = 1.0 if st == 'pass' else (None if st == 'na' else (0.5 if st == 'warn' else 0.0))
    add('speed.ttfb', 'speed', 'Time to First Byte Response', st, sc,
        "TTFB measurement missing." if st == 'na' else f"Server TTFB is {ttfb} ms.", {'ttfb_ms': ttfb}, 2.0)

    # 13. speed.html_size
    hb = tm.get('html_bytes') if tm and isinstance(tm.get('html_bytes'), int) else None
    st = 'na' if hb is None else ('pass' if hb <= 500 * 1024 else ('warn' if hb <= 1500 * 1024 else 'fail'))
    sc = 1.0 if st == 'pass' else (None if st == 'na' else (0.5 if st == 'warn' else 0.0))
    add('speed.html_size', 'speed', 'HTML Document Transfer Size', st, sc,
        "HTML size data missing." if st == 'na' else f"HTML size is {round(hb / 1024.0, 1)} KB.", {'html_bytes': hb})

    # 14. speed.compression (weight 2)
    ce = tm.get('content_encoding').strip().lower() if tm and isinstance(tm.get('content_encoding'), str) else ''
    st = 'na' if tm is None else ('pass' if any(a in ce for a in ('br', 'gzip', 'zstd', 'deflate')) else 'fail')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.0)
    add('speed.compression', 'speed', 'HTTP Transfer Content Encoding Compression', st, sc,
        "Timing missing." if st == 'na' else (f"Compression enabled ({ce})." if st == 'pass' else "Compression missing."),
        {'content_encoding': tm.get('content_encoding') if tm else None}, 2.0)

    # 15. speed.caching
    cc = tm.get('cache_control').strip() if tm and isinstance(tm.get('cache_control'), str) else ''
    st = 'na' if tm is None else ('pass' if cc else 'warn')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.5)
    add('speed.caching', 'speed', 'HTTP Response Cache Control Header', st, sc,
        "Timing missing." if st == 'na' else (f"Cache-Control present ({cc})." if cc else "Cache-Control header missing."),
        {'cache_control': tm.get('cache_control') if tm else None})

    # 16. speed.http_version
    hv = tm.get('http_version').strip() if tm and isinstance(tm.get('http_version'), str) else ''
    hvl = hv.lower()
    st = 'na' if not hv else ('pass' if any(v in hvl for v in ('http/2', 'http/3', 'h2', 'h3', '2.0', '3.0')) else 'warn')
    sc = 1.0 if st == 'pass' else (None if st == 'na' else 0.5)
    det = "HTTP version missing." if st == 'na' else (f"Modern protocol ({hv})." if st == 'pass' else f"Legacy or unverified protocol ({hv}).")
    add('speed.http_version', 'speed', 'Modern HTTP Protocol Version', st, sc, det, {'http_version': tm.get('http_version') if tm else None})

    return res
