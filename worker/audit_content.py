"""Content audit module for website benchmark tool scoring SEO and GEO."""

import re
import urllib.parse

QUESTION_WORDS = {"what", "how", "why", "when", "where", "which", "who", "can", "does", "is", "are", "should"}
AUTH_TLDS = (".gov", ".edu", ".int")
AUTH_DOMAINS = ("wikipedia.org", "doi.org", "who.int", "arxiv.org", "nih.gov")
SOCIAL_PATTERNS = (
    "facebook.com/sharer", "twitter.com/intent", "twitter.com/share", "x.com/intent",
    "x.com/share", "linkedin.com/share", "pinterest.com/pin", "reddit.com/submit",
    "t.me/share", "api.whatsapp.com", "wa.me"
)

STAT_RE = re.compile(
    r'(?:[\$]\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:million|billion|trillion|[kmb]))?\b'
    r'|\b\d+(?:\.\d+)?\s*%'
    r'|\b\d+(?:\.\d+)?\s*(?:percent(?:age)?|usd|eur|gbp|jpy|dollars?|cents?)\b'
    r'|\b\d+(?:\.\d+)?\s*(?:million|billion|trillion|[kmb])\b'
    r'|\b\d+(?:\.\d+)?\s*(?:kg|g|mg|lbs?|oz|km|m|cm|mm|mi|miles?|ft|feet|in|inches|hours?|hrs?|mins?|minutes?|sec|seconds?|days?|weeks?|months?|years?|kb|mb|gb|tb|mph|kph)\b'
    r'|\b(?:19|20)\d{2}\b)',
    re.I
)
MONTHS = r'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
DATE_RE = re.compile(
    rf'(?:\b(?:19|20)\d{{2}}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b'
    rf'|\b(?:{MONTHS})\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{{2}}\b'
    rf'|\b\d{{1,2}}(?:st|nd|rd|th)?\s+(?:{MONTHS})\s+(?:19|20)\d{{2}}\b'
    rf'|\b(?:{MONTHS})\s+(?:19|20)\d{{2}}\b)',
    re.I
)
YEAR_RE = re.compile(r'\b(?:19|20)\d{2}\b')
QUOTE_RE = re.compile(r'["\u201c][^"\u201d]{8,500}["\u201d]')
ATTR_VERBS = re.compile(r'\b(?:said|says|stated|noted|according to|claimed|reported|explained|argued)\b', re.I)
NAME_ATTR_RE = re.compile(
    r'(?:["\u201c][^"\u201d]{8,500}["\u201d]\s*[-\u2013\u2014]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?'
    r'|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*,\s*["\u201c])'
)


def _check(cid, group, title, status, score, detail, data=None, weight=1.0):
    """Build a standard check record."""
    sc = None if status == "na" else round(max(0.0, min(1.0, float(score))), 2)
    return {
        "id": cid, "group": group, "title": title, "status": status,
        "score": sc, "weight": float(weight), "detail": detail, "data": data or {}
    }


def _safe_page(p):
    return p if isinstance(p, dict) else {}


def _is_q(text):
    t = (text or "").strip()
    return bool(t) and (t.endswith("?") or (re.split(r"\W+", t.lower())[0] in QUESTION_WORDS))


def _has_faq_jsonld(obj, depth=0):
    if depth > 10 or obj is None:
        return False
    if isinstance(obj, dict):
        t = obj.get("@type")
        is_faq = (isinstance(t, str) and t.lower() == "faqpage") or (
            isinstance(t, list) and any(isinstance(x, str) and x.lower() == "faqpage" for x in t)
        )
        return is_faq or any(_has_faq_jsonld(v, depth + 1) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_faq_jsonld(item, depth + 1) for item in obj)
    return False


def _is_auth(domain):
    d = (domain or "").lower().strip()
    if not d:
        return False
    if d.endswith(AUTH_TLDS) or any(d == a or d.endswith("." + a) for a in AUTH_DOMAINS):
        return True
    parts = d.split(".")
    return len(parts) >= 3 and parts[-2] == "ac" and len(parts[-1]) == 2


def answer_checks(page):
    """Evaluate question headings, opening answers, chunk sizes, and outline."""
    p = _safe_page(page)
    headings = [h for h in (p.get("headings") or []) if isinstance(h, dict)]
    sections = [s for s in (p.get("sections") or []) if isinstance(s, dict)]
    checks = []

    # 1. answer.question_headings
    h23 = [h for h in headings if h.get("level") in (2, 3)]
    if len(h23) < 2:
        checks.append(_check(
            "answer.question_headings", "answer", "Question Headings for Direct Answers",
            "na", None, "Fewer than 2 H2/H3 headings found, so question heading ratio cannot be evaluated.",
            {"h2_h3_count": len(h23), "question_headings": 0, "ratio": 0.0}
        ))
    else:
        qc = sum(1 for h in h23 if _is_q(h.get("text", "")))
        ratio = qc / len(h23)
        st = "pass" if ratio >= 0.20 else ("warn" if qc > 0 else "fail")
        sc = 1.0 if st == "pass" else (0.5 if st == "warn" else 0.0)
        det = (f"Found {qc} question headings ({round(ratio * 100, 1)}% of H2/H3s), meeting target."
               if st == "pass" else
               f"Only {qc} question headings found ({round(ratio * 100, 1)}% of H2/H3s); aim for at least 20%.")
        checks.append(_check("answer.question_headings", "answer", "Question Headings for Direct Answers",
                             st, sc, det, {"h2_h3_count": len(h23), "question_headings": qc, "ratio": round(ratio, 3)}))

    # 2. answer.answer_first (weight 2)
    headed = [s for s in sections if s.get("heading")]
    if not headed:
        checks.append(_check("answer.answer_first", "answer", "Direct Answer in Opening Paragraph",
                             "na", None, "No sections with headings found to evaluate opening answers.",
                             {"sections_with_heading": 0, "answering_sections": 0, "ratio": 0.0}, weight=2.0))
    else:
        ans = sum(1 for s in headed if (s.get("paragraphs") or []) and isinstance(s["paragraphs"][0], str)
                  and 15 <= len(s["paragraphs"][0].split()) <= 80)
        ratio = ans / len(headed)
        st = "pass" if ratio >= 0.5 else ("warn" if ratio > 0.0 else "fail")
        det = (f"{ans} of {len(headed)} sections open with a direct answer paragraph of 15-80 words." if st == "pass"
               else f"Only {ans} of {len(headed)} sections start with a 15-80 word direct answer; begin each section with one.")
        checks.append(_check("answer.answer_first", "answer", "Direct Answer in Opening Paragraph",
                             st, ratio, det, {"sections_with_heading": len(headed), "answering_sections": ans, "ratio": round(ratio, 3)}, weight=2.0))

    # 3. answer.chunk_size (weight 2)
    if not sections:
        checks.append(_check("answer.chunk_size", "answer", "Self Contained Section Chunk Size",
                             "na", None, "No content sections found to evaluate chunk sizes.",
                             {"total_sections": 0, "in_range_sections": 0, "ratio": 0.0}, weight=2.0))
    else:
        _sw = lambda s: s.get("words") if isinstance(s.get("words"), (int, float)) else sum(len(x.split()) for x in (s.get("paragraphs") or []) if isinstance(x, str))
        in_rng = sum(1 for s in sections if 40 <= _sw(s) <= 350)
        ratio = in_rng / len(sections)
        st = "pass" if ratio >= 0.6 else ("warn" if ratio >= 0.3 else "fail")
        det = (f"{in_rng} of {len(sections)} sections are sized between 40 and 350 words, ideal for AI citations."
               if st == "pass" else
               f"Only {in_rng} of {len(sections)} sections fall in 40-350 word range; resize content into bite-sized chunks.")
        checks.append(_check("answer.chunk_size", "answer", "Self Contained Section Chunk Size",
                             st, ratio, det, {"total_sections": len(sections), "in_range_sections": in_rng, "ratio": round(ratio, 3)}, weight=2.0))

    # 4. answer.structure
    lc = p.get("lists") if isinstance(p.get("lists"), int) else sum(int(s.get("lists") or 0) for s in sections)
    tc = p.get("tables") if isinstance(p.get("tables"), int) else sum(int(s.get("tables") or 0) for s in sections)
    has_struct = lc > 0 or tc > 0
    checks.append(_check(
        "answer.structure", "answer", "Structured Lists and Data Tables",
        "pass" if has_struct else "fail", 1.0 if has_struct else 0.0,
        f"Found {lc} lists and {tc} tables providing structured data." if has_struct
        else "No lists or tables found; add structured lists or tables to aid generative extraction.",
        {"lists": lc, "tables": tc}
    ))

    # 5. answer.faq
    faq_j = _has_faq_jsonld(p.get("jsonld"))
    faq_h = any(bool(re.search(r"\bfaq\b|frequently\s+asked", h.get("text", ""), re.I)) for h in headings)
    has_faq = faq_j or faq_h
    checks.append(_check(
        "answer.faq", "answer", "FAQ Schema or Dedicated Section",
        "pass" if has_faq else "warn", 1.0 if has_faq else 0.5,
        "Found FAQ structured data or dedicated FAQ heading." if has_faq
        else "No FAQ schema or section found; adding FAQ blocks helps capture conversational questions.",
        {"has_faq_jsonld": faq_j, "has_faq_heading": faq_h}
    ))

    # 6. answer.summary_first
    f_paras = sections[0].get("paragraphs") or [] if sections else (p.get("paragraphs") or [])
    intro_w = len(f_paras[0].split()) if f_paras and isinstance(f_paras[0], str) else 0
    has_sum_h = any(bool(re.search(r"\b(tl;?dr|summary|key takeaways)\b", h.get("text", ""), re.I)) for h in headings)
    if (20 <= intro_w <= 120) or has_sum_h:
        s_st, s_sc, s_det = "pass", 1.0, "Found lead-in summary paragraph or dedicated summary heading before main sections."
    elif intro_w > 0:
        s_st, s_sc, s_det = "warn", 0.5, f"Intro paragraph length ({intro_w} words) is outside recommended 20-120 word range; adjust length."
    else:
        s_st, s_sc, s_det = "fail", 0.0, "No intro summary (20-120 words) or TL;DR heading found; add an upfront summary."
    checks.append(_check("answer.summary_first", "answer", "Lead In Summary or Takeaways",
                         s_st, s_sc, s_det, {"intro_words": intro_w, "has_summary_heading": has_sum_h}))

    # 7. answer.headings_outline
    h_levels = [h.get("level") for h in headings if isinstance(h.get("level"), int)]
    if not h_levels:
        checks.append(_check("answer.headings_outline", "answer", "Logical Sequential Headings Outline",
                             "fail", 0.0, "No headings found on page; organize content with a clear heading outline.",
                             {"h1_count": 0, "skipped_levels": False}))
    else:
        h1_cnt = sum(1 for lvl in h_levels if lvl == 1)
        skipped = any(curr > prev + 1 for prev, curr in zip(h_levels, h_levels[1:]))
        if h1_cnt == 1 and not skipped:
            o_st, o_sc, o_det = "pass", 1.0, "Heading outline has exactly one H1 and sequential heading levels."
        elif h1_cnt == 1 or not skipped:
            o_st, o_sc, o_det = "warn", 0.5, f"Heading outline has structural flaws ({h1_cnt} H1s, skipped levels={skipped}); fix hierarchy."
        else:
            o_st, o_sc, o_det = "fail", 0.0, f"Heading outline is broken ({h1_cnt} H1s, skipped levels={skipped}); fix heading structure."
        checks.append(_check("answer.headings_outline", "answer", "Logical Sequential Headings Outline",
                             o_st, o_sc, o_det, {"h1_count": h1_cnt, "skipped_levels": skipped}))

    # 8. answer.paragraph_length
    paras = [ps for ps in (p.get("paragraphs") or []) if isinstance(ps, str) and ps.strip()]
    if not paras:
        checks.append(_check("answer.paragraph_length", "answer", "Concise Quotable Paragraph Length",
                             "na", None, "No paragraphs found to evaluate paragraph length.",
                             {"paragraph_count": 0, "median_words": 0}))
    else:
        lens = sorted(len(ps.split()) for ps in paras)
        n = len(lens)
        med = float(lens[n // 2]) if n % 2 == 1 else round((lens[n // 2 - 1] + lens[n // 2]) / 2.0, 1)
        p_st = "pass" if med <= 90 else ("warn" if med <= 120 else "fail")
        p_sc = 1.0 if p_st == "pass" else (0.5 if p_st == "warn" else 0.0)
        p_det = (f"Median paragraph length is {med} words, keeping content concise and quotable." if p_st == "pass"
                 else f"Median paragraph length is {med} words (target <= 90); shorten paragraphs for easier citation.")
        checks.append(_check("answer.paragraph_length", "answer", "Concise Quotable Paragraph Length",
                             p_st, p_sc, p_det, {"paragraph_count": n, "median_words": med}))

    return checks


def citability_checks(page):
    """Evaluate statistics density, quotations, external sources, and dates."""
    p = _safe_page(page)
    checks = []
    text = p.get("text") or ""
    if not isinstance(text, str):
        text = ""
    wc = p.get("word_count") if isinstance(p.get("word_count"), int) and p.get("word_count") > 0 else len(text.split())

    # 1. citability.statistics (weight 2)
    if wc < 30:
        checks.append(_check("citability.statistics", "citability", "Factual Statistics and Quantified Data",
                             "na", None, "Too few words to evaluate statistical density.",
                             {"word_count": wc, "stat_count": 0, "rate_per_1000": 0.0}, weight=2.0))
    else:
        cnt = len(STAT_RE.findall(text))
        rate = (cnt / wc) * 1000.0
        st = "pass" if rate >= 3.0 else ("warn" if rate >= 1.0 else "fail")
        sc = 1.0 if st == "pass" else (0.5 if st == "warn" else 0.0)
        det = (f"Found {cnt} statistics ({round(rate, 1)} per 1k words), exceeding target density." if st == "pass"
               else f"Found {cnt} statistics ({round(rate, 1)} per 1k words); add more data to raise citability.")
        checks.append(_check("citability.statistics", "citability", "Factual Statistics and Quantified Data",
                             st, sc, det, {"word_count": wc, "stat_count": cnt, "rate_per_1000": round(rate, 2)}, weight=2.0))

    # 2. citability.quotations
    paras = [ps for ps in (p.get("paragraphs") or []) if isinstance(ps, str)]
    if not paras and text:
        paras = [line for line in text.split("\n") if line.strip()]
    if wc < 40 and not paras:
        checks.append(_check("citability.quotations", "citability", "Attributed Quotations from Expert Sources",
                             "na", None, "Too few words to evaluate quotations.", {"quote_count": 0}))
    else:
        qc = sum(1 for para in paras if QUOTE_RE.search(para) and (ATTR_VERBS.search(para) or NAME_ATTR_RE.search(para)))
        if qc >= 2:
            st, sc, det = "pass", 1.0, f"Found {qc} attributed quotations supporting claims with authority."
        elif qc == 1:
            st, sc, det = "warn", 0.5, "Found 1 attributed quotation; cite 2 or more expert sources to maximize citability."
        else:
            st, sc, det = "fail", 0.0, "No attributed quotations found; quoting recognized experts improves generative citations."
        checks.append(_check("citability.quotations", "citability", "Attributed Quotations from Expert Sources",
                             st, sc, det, {"quote_count": qc}))

    # 3. citability.sources (weight 2)
    ext_domains, auth_domains = set(), set()
    for link in (p.get("links") or []):
        if not isinstance(link, dict) or link.get("internal") is not False:
            continue
        href = (link.get("href") or "").strip()
        if not href or any(sp in href.lower() for sp in SOCIAL_PATTERNS):
            continue
        netloc = urllib.parse.urlparse(href).netloc.lower().split(":")[0]
        if netloc.startswith("www."):
            netloc = netloc[4:]
        if netloc and "." in netloc:
            ext_domains.add(netloc)
            if _is_auth(netloc):
                auth_domains.add(netloc)

    raw_pts = (len(ext_domains) - len(auth_domains)) * 0.25 + len(auth_domains) * 0.50
    score = min(1.0, round(raw_pts, 2))
    st = "pass" if score >= 0.7 else ("warn" if score > 0.0 else "fail")
    det = (f"Found {len(ext_domains)} external domains ({len(auth_domains)} authoritative) cited in content." if score > 0.0
           else "No external sources cited; link to authoritative references to improve AI verification.")
    checks.append(_check("citability.sources", "citability", "External Citations to Authoritative Sources",
                         st, score, det,
                         {"external_domains": len(ext_domains), "authoritative_domains": len(auth_domains),
                          "domains": sorted(list(ext_domains))[:10]}, weight=2.0))

    # 4. citability.dated
    time_tags = [t for t in (p.get("time_tags") or []) if isinstance(t, str) and t.strip()]
    if wc < 30 and not time_tags:
        checks.append(_check("citability.dated", "citability", "Temporal Grounding with Explicit Dates",
                             "na", None, "Too few words to evaluate temporal grounding.",
                             {"time_tags": 0, "full_dates": 0, "years": 0}))
    else:
        full_d = len(DATE_RE.findall(text))
        years = len(YEAR_RE.findall(text))
        if time_tags or full_d >= 1 or years >= 2:
            st, sc, det = "pass", 1.0, f"Content includes temporal markers ({len(time_tags)} time tags, {full_d} full dates, {years} years)."
        elif years == 1:
            st, sc, det = "warn", 0.5, "Only 1 year mention found; provide explicit publication and update dates."
        else:
            st, sc, det = "fail", 0.0, "No dates or years found; anchor content with temporal markers so AI can verify freshness."
        checks.append(_check("citability.dated", "citability", "Temporal Grounding with Explicit Dates",
                             st, sc, det, {"time_tags": len(time_tags), "full_dates": full_d, "years": years}))

    return checks


def render_checks(page):
    """Evaluate raw HTML accessibility without JavaScript and text ratio."""
    p = _safe_page(page)
    text = p.get("text") or ""
    if not isinstance(text, str):
        text = ""
    wc = p.get("word_count") if isinstance(p.get("word_count"), int) and p.get("word_count") >= 0 else len(text.split())
    sb = p.get("script_bytes") if isinstance(p.get("script_bytes"), int) and p.get("script_bytes") >= 0 else 0
    sc_cnt = p.get("scripts") if isinstance(p.get("scripts"), int) and p.get("scripts") >= 0 else 0
    hb = p.get("html_bytes") if isinstance(p.get("html_bytes"), int) and p.get("html_bytes") >= 0 else 0
    checks = []

    # 1. ai_access.no_js_content (weight 3)
    needs_js = "enable javascript" in text.lower()
    if wc < 50 and (sb > 100000 or needs_js or sc_cnt >= 5):
        js_st, js_sc, js_det = "fail", 0.0, "Judged from raw HTML only: content requires JavaScript and is unreadable by AI crawlers."
    elif 50 <= wc <= 200 and sb > 300000:
        js_st, js_sc, js_det = "warn", 0.5, "Judged from raw HTML only: low word count with heavy scripts may hide content from AI crawlers."
    else:
        js_st, js_sc, js_det = "pass", 1.0, "Judged from raw HTML only: main content is fully accessible without JavaScript execution."
    checks.append(_check("ai_access.no_js_content", "ai_access", "Content Accessible Without JavaScript",
                         js_st, js_sc, js_det, {"word_count": wc, "script_bytes": sb, "scripts": sc_cnt}, weight=3.0))

    # 2. ai_access.text_ratio
    if hb <= 0:
        checks.append(_check("ai_access.text_ratio", "ai_access", "Text to HTML Ratio",
                             "na", None, "HTML byte size is zero or missing; cannot calculate text ratio.",
                             {"text_len": len(text), "html_bytes": hb, "ratio": 0.0}))
    else:
        ratio = len(text) / hb
        st = "fail" if ratio < 0.02 else ("warn" if ratio < 0.05 else "pass")
        sc = 0.0 if st == "fail" else (0.5 if st == "warn" else 1.0)
        det = (f"Text-to-HTML ratio is healthy at {round(ratio * 100, 2)}%." if st == "pass"
               else f"Text-to-HTML ratio is {round(ratio * 100, 2)}% (under {'2%' if st == 'fail' else '5%'}); reduce HTML bloat.")
        checks.append(_check("ai_access.text_ratio", "ai_access", "Text to HTML Ratio",
                             st, sc, det, {"text_len": len(text), "html_bytes": hb, "ratio": round(ratio, 4)}))

    return checks


def audit_content(page):
    """Run all content audit checks across answer, citability, and ai_access groups."""
    return answer_checks(page) + citability_checks(page) + render_checks(page)
