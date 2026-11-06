import re
from typing import Any

# AI crawler catalog with purpose: training, search, or user.
AI_BOTS: list[dict[str, str]] = [
    {"token": "GPTBot", "owner": "OpenAI", "purpose": "training"},
    {"token": "OAI-SearchBot", "owner": "OpenAI", "purpose": "search"},
    {"token": "ChatGPT-User", "owner": "OpenAI", "purpose": "user"},
    {"token": "ClaudeBot", "owner": "Anthropic", "purpose": "training"},
    {"token": "Claude-SearchBot", "owner": "Anthropic", "purpose": "search"},
    {"token": "Claude-User", "owner": "Anthropic", "purpose": "user"},
    {"token": "PerplexityBot", "owner": "Perplexity", "purpose": "search"},
    {"token": "Perplexity-User", "owner": "Perplexity", "purpose": "user"},
    {"token": "Google-Extended", "owner": "Google", "purpose": "training"},
    {"token": "Googlebot", "owner": "Google", "purpose": "search"},
    {"token": "Bingbot", "owner": "Microsoft", "purpose": "search"},
    {"token": "Applebot-Extended", "owner": "Apple", "purpose": "training"},
    {"token": "CCBot", "owner": "Common Crawl", "purpose": "training"},
    {"token": "Bytespider", "owner": "ByteDance", "purpose": "training"},
    {"token": "meta-externalagent", "owner": "Meta", "purpose": "training"},
    {"token": "Amazonbot", "owner": "Amazon", "purpose": "training"},
    {"token": "DuckAssistBot", "owner": "DuckDuckGo", "purpose": "search"},
    {"token": "MistralAI-User", "owner": "Mistral AI", "purpose": "user"},
]

_BOT_UA_MAP: dict[str, str] = {
    "gptbot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "oai-searchbot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
    "chatgpt-user": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
    "claudebot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "claude-searchbot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +claude-searchbot@anthropic.com)",
    "claude-user": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)",
    "perplexitybot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "perplexity-user": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexitybot)",
    "google-extended": "Mozilla/5.0 (compatible; Google-Extended; +https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers)",
    "googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "bingbot": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "applebot-extended": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot-Extended/0.1; +http://www.apple.com/go/applebot)",
    "ccbot": "CCBot/2.0 (https://commoncrawl.org/faq/)",
    "bytespider": "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
    "meta-externalagent": "Mozilla/5.0 (compatible; meta-externalagent/1.1; +https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "amazonbot": "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)",
    "duckassistbot": "Mozilla/5.0 (compatible; DuckAssistBot/1.0; +https://duckduckgo.com/duckduckgo-help-pages/duckassist/)",
    "mistralai-user": "Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://mistral.ai)",
}


def bot_user_agent(token: str) -> str:
    # Return a realistic User-Agent string for the given bot token.
    if not token or not isinstance(token, str):
        return "Mozilla/5.0 (compatible; Bot/1.0)"
    clean = token.strip()
    return _BOT_UA_MAP.get(clean.lower(), f"Mozilla/5.0 (compatible; {clean}/1.0; +https://example.com/bot)")


def parse_robots(text: str | None) -> list[dict[str, Any]]:
    # Parse robots.txt lines into user-agent directive groups.
    if not text or not isinstance(text, str):
        return []
    groups: list[dict[str, Any]] = []
    agents: list[str] = []
    rules: list[dict[str, str]] = []

    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, val = line.split(":", 1)
        key, val = key.strip().lower(), val.strip()

        if key == "user-agent":
            if rules:
                groups.append({"agents": agents, "user_agents": agents, "rules": rules})
                agents, rules = [], []
            if val:
                agents.append(val)
        elif key in ("allow", "disallow") and agents:
            rules.append({"type": key, "path": val})

    if agents:
        groups.append({"agents": agents, "user_agents": agents, "rules": rules})
    return groups


def sitemaps_in(text: str | None) -> list[str]:
    # Extract distinct Sitemap URLs in order of appearance.
    if not text or not isinstance(text, str):
        return []
    sitemaps: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, val = line.split(":", 1)
        if key.strip().lower() == "sitemap":
            url = val.strip()
            if url and url not in sitemaps:
                sitemaps.append(url)
    return sitemaps


def _match_path(pattern: str, path: str) -> bool:
    # Match an RFC 9309 path pattern supporting '*' and end anchor '$'.
    if not pattern:
        return False
    has_end = pattern.endswith("$")
    core = pattern[:-1] if has_end else pattern
    escaped = [re.escape(part) for part in core.split("*")]
    regex = "^" + ".*".join(escaped) + ("$" if has_end else "")
    try:
        return bool(re.match(regex, path))
    except Exception:
        return False


def allowed(text: str | None, ua_token: str | None, path: str = "/") -> bool:
    # Determine crawler permission following RFC 9309 and Google rules.
    if not text or not isinstance(text, str) or not text.strip():
        return True
    groups = parse_robots(text)
    if not groups:
        return True

    target = (ua_token or "*").strip().lower()
    norm_path = path.strip() if isinstance(path, str) and path.strip() else "/"
    if not norm_path.startswith("/"):
        norm_path = "/" + norm_path

    # Group selection: find longest matching product token across all groups
    best_len = -1
    best_token: str | None = None
    for g in groups:
        for a in g.get("agents", []):
            token = a.split("/")[0].strip().lower()
            if token != "*" and (token == target or target.startswith(token)):
                if len(token) > best_len:
                    best_len = len(token)
                    best_token = token

    # Merge rules from all groups matching the winning token or wildcard fallback
    rules: list[dict[str, str]] = []
    if best_token is not None:
        for g in groups:
            matched = [a.split("/")[0].strip().lower() for a in g.get("agents", [])]
            if best_token in matched:
                rules.extend(g.get("rules", []))
    else:
        for g in groups:
            if "*" in [a.strip() for a in g.get("agents", [])]:
                rules.extend(g.get("rules", []))

    if not rules:
        return True

    # Longest matching rule wins; on equal length, Allow overrides Disallow
    longest_len = -1
    verdict: str | None = None
    for r in rules:
        rpath = r.get("path", "")
        if not rpath:
            continue
        if _match_path(rpath, norm_path):
            rlen = len(rpath)
            if rlen > longest_len:
                longest_len = rlen
                verdict = r.get("type", "").lower()
            elif rlen == longest_len and r.get("type", "").lower() == "allow":
                verdict = "allow"

    return verdict != "disallow"


def _check(cid: str, grp: str, title: str, st: str, sc: float | None, wt: float, det: str, dat: dict[str, Any]) -> dict[str, Any]:
    # Build a standardized check dictionary.
    return {
        "id": cid,
        "group": grp,
        "title": title,
        "status": st,
        "score": sc,
        "weight": wt,
        "detail": det,
        "data": dat,
    }


def robots_checks(
    robots_status: int | None,
    robots_text: str | None,
    path: str = "/",
) -> list[dict[str, Any]]:
    # Produce benchmark check records for robots.txt status, crawlers, and AI access.
    norm_path = path.strip() if isinstance(path, str) and path.strip() else "/"
    if not norm_path.startswith("/"):
        norm_path = "/" + norm_path

    st_code: int | None = None
    if robots_status is not None:
        try:
            st_code = int(robots_status)
        except (ValueError, TypeError):
            st_code = None

    txt = robots_text if isinstance(robots_text, str) else ""
    is_5xx = st_code is not None and 500 <= st_code < 600
    is_none = st_code is None and not txt.strip()

    # Check 1: crawl.robots_present
    if st_code is None:
        c1 = _check("crawl.robots_present", "crawl", "Robots.txt Availability and Status", "na", None, 1.0, "Robots.txt HTTP status was not provided.", {"status": None})
    elif is_5xx:
        c1 = _check("crawl.robots_present", "crawl", "Robots.txt Availability and Status", "fail", 0.0, 1.0, "Robots.txt returned a 5xx error which Google treats as a full crawl block.", {"status": st_code})
    elif st_code == 404:
        c1 = _check("crawl.robots_present", "crawl", "Robots.txt Availability and Status", "warn", 0.5, 1.0, "Robots.txt returned 404 not found, which allows all crawlers by default.", {"status": 404})
    elif st_code == 200:
        if txt.strip():
            c1 = _check("crawl.robots_present", "crawl", "Robots.txt Availability and Status", "pass", 1.0, 1.0, "Robots.txt answered 200 with directives.", {"status": 200, "bytes": len(txt)})
        else:
            c1 = _check("crawl.robots_present", "crawl", "Robots.txt Availability and Status", "warn", 0.5, 1.0, "Robots.txt returned 200 but contained no text directives.", {"status": 200, "bytes": 0})
    else:
        c1 = _check("crawl.robots_present", "crawl", "Robots.txt Availability and Status", "fail", 0.0, 1.0, f"Robots.txt returned unexpected HTTP status {st_code}.", {"status": st_code})

    # Check 2: crawl.googlebot_allowed (weight 3)
    if is_none:
        c2 = _check("crawl.googlebot_allowed", "crawl", "Googlebot Crawl Access", "na", None, 3.0, "Robots.txt data is unavailable to evaluate Googlebot access.", {"path": norm_path, "allowed": None})
    elif is_5xx:
        c2 = _check("crawl.googlebot_allowed", "crawl", "Googlebot Crawl Access", "fail", 0.0, 3.0, f"Googlebot is blocked from crawling {norm_path} due to 5xx robots.txt error.", {"path": norm_path, "allowed": False, "status": st_code})
    else:
        g_ok = allowed(txt, "Googlebot", norm_path)
        c2 = _check(
            "crawl.googlebot_allowed", "crawl", "Googlebot Crawl Access",
            "pass" if g_ok else "fail", 1.0 if g_ok else 0.0, 3.0,
            f"Googlebot is permitted to crawl {norm_path}." if g_ok else f"Googlebot is disallowed from crawling {norm_path}.",
            {"path": norm_path, "allowed": g_ok},
        )

    # Check 3: crawl.sitemap_listed
    sitemaps = sitemaps_in(txt)
    if is_none:
        c3 = _check("crawl.sitemap_listed", "crawl", "Sitemap Listed in Robots.txt", "na", None, 1.0, "Robots.txt data is unavailable to check for sitemaps.", {"sitemaps": [], "count": 0})
    elif sitemaps:
        c3 = _check("crawl.sitemap_listed", "crawl", "Sitemap Listed in Robots.txt", "pass", 1.0, 1.0, f"Found {len(sitemaps)} sitemap URL(s) declared in robots.txt.", {"sitemaps": sitemaps, "count": len(sitemaps)})
    else:
        c3 = _check("crawl.sitemap_listed", "crawl", "Sitemap Listed in Robots.txt", "warn", 0.0, 1.0, "No Sitemap directive was found in robots.txt; declare one to aid indexing.", {"sitemaps": [], "count": 0})

    # Check 4: ai_access.search_bots (weight 3)
    search_bots = [b for b in AI_BOTS if b["purpose"] in ("search", "user")]
    if is_none:
        c4 = _check("ai_access.search_bots", "ai_access", "AI Search and User Bots Access", "na", None, 3.0, "Robots.txt data is unavailable to evaluate AI search bots.", {"path": norm_path, "total": len(search_bots)})
    elif is_5xx:
        blocked_tokens = [b["token"] for b in search_bots]
        c4 = _check("ai_access.search_bots", "ai_access", "AI Search and User Bots Access", "fail", 0.0, 3.0, f"All AI search and user bots are blocked on {norm_path} by 5xx error.", {"path": norm_path, "total": len(search_bots), "allowed_count": 0, "blocked_count": len(search_bots), "blocked": blocked_tokens})
    else:
        blocked_s = [b["token"] for b in search_bots if not allowed(txt, b["token"], norm_path)]
        allowed_s_count = len(search_bots) - len(blocked_s)
        total_s = len(search_bots)
        share_s = round(allowed_s_count / total_s, 3) if total_s else 1.0
        if allowed_s_count == total_s:
            st_s, det_s = "pass", f"All {total_s} AI search and user bots are allowed to access {norm_path}."
        elif allowed_s_count == 0:
            st_s, det_s = "fail", f"All {total_s} AI search and user bots are blocked from {norm_path}."
        else:
            st_s, det_s = "warn", f"{allowed_s_count} of {total_s} AI search and user bots allowed for {norm_path}; blocked: {', '.join(blocked_s)}."
        c4 = _check("ai_access.search_bots", "ai_access", "AI Search and User Bots Access", st_s, share_s, 3.0, det_s, {"path": norm_path, "total": total_s, "allowed_count": allowed_s_count, "blocked_count": len(blocked_s), "blocked": blocked_s})

    # Check 5: ai_access.training_bots (weight 1)
    train_bots = [b for b in AI_BOTS if b["purpose"] == "training"]
    if is_none:
        c5 = _check("ai_access.training_bots", "ai_access", "AI Training Bots Crawl Permission", "na", None, 1.0, "Robots.txt data is unavailable to evaluate AI training bots.", {"path": norm_path, "total": len(train_bots)})
    elif is_5xx:
        blocked_t = [b["token"] for b in train_bots]
        c5 = _check("ai_access.training_bots", "ai_access", "AI Training Bots Crawl Permission", "warn", 0.0, 1.0, "AI training bots are blocked due to server error; this is a policy choice.", {"path": norm_path, "total": len(train_bots), "allowed_count": 0, "blocked_count": len(train_bots), "blocked": blocked_t})
    else:
        blocked_t = [b["token"] for b in train_bots if not allowed(txt, b["token"], norm_path)]
        allowed_t_count = len(train_bots) - len(blocked_t)
        total_t = len(train_bots)
        share_t = round(allowed_t_count / total_t, 3) if total_t else 1.0
        if allowed_t_count == total_t:
            st_t, det_t = "pass", f"All {total_t} AI training bots are allowed to crawl {norm_path}."
        else:
            st_t, det_t = "warn", f"{allowed_t_count} of {total_t} AI training bots allowed for {norm_path}; blocking training crawlers is a valid policy choice."
        c5 = _check("ai_access.training_bots", "ai_access", "AI Training Bots Crawl Permission", st_t, share_t, 1.0, det_t, {"path": norm_path, "total": total_t, "allowed_count": allowed_t_count, "blocked_count": len(blocked_t), "blocked": blocked_t})

    # Check 6: ai_access.wildcard_block (weight 2)
    if is_none:
        c6 = _check("ai_access.wildcard_block", "ai_access", "Wildcard Disallow Root Block", "na", None, 2.0, "Robots.txt data is unavailable to inspect wildcard rules.", {"wildcard_blocks_root": None})
    else:
        wildcard_blocks_root = False
        for g in parse_robots(txt):
            if "*" in [a.strip() for a in g.get("agents", [])]:
                for r in g.get("rules", []):
                    if r.get("type") == "disallow" and r.get("path") in ("/", "/*", "/*$") and not allowed(txt, "*", "/"):
                        wildcard_blocks_root = True
                        break
        if wildcard_blocks_root:
            c6 = _check("ai_access.wildcard_block", "ai_access", "Wildcard Disallow Root Block", "fail", 0.0, 2.0, "A 'User-agent: *' group disallows '/', blocking all unspecified crawlers.", {"wildcard_blocks_root": True})
        else:
            c6 = _check("ai_access.wildcard_block", "ai_access", "Wildcard Disallow Root Block", "pass", 1.0, 2.0, "No wildcard 'User-agent: *' rule disallows the root path.", {"wildcard_blocks_root": False})

    return [c1, c2, c3, c4, c5, c6]


# ---------------------------------------------------------------- llms.txt, noai meta, firewall

def llms_txt_checks(status, text, content_type):
    """/llms.txt per llmstxt.org: a young, optional standard, so missing is a warn."""
    ctype = (content_type or '').lower()
    body = text or ''
    looks_html = 'html' in ctype or body.lstrip()[:15].lower().startswith(('<!doctype', '<html'))
    if status is None:
        return [_check('ai_access.llms_txt_present', 'ai_access', 'llms.txt file present', 'na', None, 1.0,
                       'llms.txt could not be read.', {'status': None})]
    if status != 200 or not body.strip():
        return [_check('ai_access.llms_txt_present', 'ai_access', 'llms.txt file present', 'warn', 0.0, 1.0,
                       'No /llms.txt. It is optional, but a short markdown map of your key pages helps AI tools find them.',
                       {'status': status})]
    if looks_html:
        return [_check('ai_access.llms_txt_present', 'ai_access', 'llms.txt file present', 'fail', 0.0, 1.0,
                       '/llms.txt answers with an HTML page (a soft 404), not a markdown file.',
                       {'status': status, 'content_type': ctype})]
    checks = [_check('ai_access.llms_txt_present', 'ai_access', 'llms.txt file present', 'pass', 1.0, 1.0,
                     '/llms.txt is there.', {'status': status, 'content_type': ctype})]
    lines = [l.rstrip() for l in body.splitlines()]
    filled = [l for l in lines if l.strip()]
    h1 = bool(filled) and filled[0].startswith('# ')
    summary = any(l.startswith('> ') for l in filled[:6])
    sections = sum(1 for l in filled if l.startswith('## '))
    links = len(re.findall(r'^\s*[-*]\s*\[[^\]]+\]\([^)]+\)', body, re.M))
    parts = [h1, summary, sections > 0, links > 0]
    score = sum(parts) / len(parts)
    missing = [name for name, ok in zip(('an H1 title first', 'a "> " summary', '"## " sections', '"- [name](url)" links'), parts) if not ok]
    checks.append(_check('ai_access.llms_txt_format', 'ai_access', 'llms.txt follows the format',
                         'pass' if score == 1 else 'warn' if score >= 0.5 else 'fail', score, 1.0,
                         'llms.txt follows the llmstxt.org layout.' if not missing else 'llms.txt is missing ' + ', '.join(missing) + '.',
                         {'links': links, 'sections': sections, 'h1': h1, 'summary': summary}))
    return checks


def ai_meta_checks(page):
    """Robots meta tags and X-Robots-Tag that keep AI tools (or everyone) away."""
    meta = (page or {}).get('meta') or {}
    headers = (page or {}).get('headers') or {}
    values = ' '.join(str(v) for v in (meta.get('robots'), meta.get('googlebot'), headers.get('x-robots-tag')) if v).lower()
    tokens = set(re.split(r'[\s,;]+', values)) if values else set()
    blocked = sorted(t for t in ('noai', 'noimageai', 'noindex', 'none') if t in tokens)
    checks = [_check('ai_access.meta_noai', 'ai_access', 'No noai or noindex directives',
                     'fail' if blocked else 'pass', 0.0 if blocked else 1.0, 2.0,
                     ('The page tells crawlers ' + ', '.join(blocked) + '; AI and search tools will skip or not use it.') if blocked
                     else 'No noai, noimageai or noindex directives.', {'directives': blocked})]
    snippet = 'nosnippet' in tokens or re.search(r'max-snippet\s*:\s*0\b', values) is not None
    checks.append(_check('ai_access.nosnippet', 'ai_access', 'Snippets allowed',
                         'warn' if snippet else 'pass', 0.0 if snippet else 1.0, 1.0,
                         'nosnippet or max-snippet:0 is set, so AI Overviews and answer engines cannot quote the page.' if snippet
                         else 'Snippets are allowed, so answer engines can quote the page.', {'nosnippet': bool(snippet)}))
    return checks


def bot_response_checks(browser, bots):
    """The same URL as each AI bot vs as Chrome. Only a hint: we fake the User-Agent from a home IP."""
    browser = browser or {}
    bots = [b for b in (bots or []) if isinstance(b, dict)]
    if not bots or browser.get('status') != 200:
        return [_check('ai_access.firewall', 'ai_access', 'AI bots not blocked by firewall', 'na', None, 2.0,
                       'Not tested.', {})]
    full = max(1, int(browser.get('bytes') or 0))
    blocked = []
    for b in bots:
        st = b.get('status')
        if b.get('error') or st is None or st in (401, 403, 429) or st >= 500 or int(b.get('bytes') or 0) < 0.3 * full:
            blocked.append({'bot': b.get('bot'), 'status': st, 'bytes': int(b.get('bytes') or 0)})
    score = 1 - len(blocked) / len(bots)
    note = ('This test sends each bot\'s User-Agent from a home IP; real bots are verified by their IP, so treat it as a hint.')
    detail = (f'{len(blocked)} of {len(bots)} AI bots got a block or a much smaller page: '
              + ', '.join(f"{b['bot']} ({b['status']})" for b in blocked) + '. ' + note) if blocked else \
             f'All {len(bots)} AI bots got the full page. ' + note
    return [_check('ai_access.firewall', 'ai_access', 'AI bots not blocked by firewall',
                   'pass' if not blocked else 'warn', score, 2.0, detail, {'blocked': blocked, 'tested': len(bots)})]
