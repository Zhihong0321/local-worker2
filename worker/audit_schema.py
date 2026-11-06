import re
import urllib.parse
from datetime import date, datetime

LOCAL_BUSINESS_SUBTYPES = {
    "LocalBusiness", "Dentist", "Physician", "Hotel", "AutoRepair", "Bakery", "BarOrPub", "CafeOrCoffeeShop",
    "ChildCare", "DryCleaningOrLaundry", "EmergencyService", "EmploymentAgency", "EntertainmentBusiness",
    "FinancialService", "FoodEstablishment", "GovernmentOffice", "HealthAndBeautyBusiness", "HomeAndConstructionBusiness",
    "InternetCafe", "LegalService", "Library", "LodgingBusiness", "MedicalBusiness", "ProfessionalService",
    "RadioStation", "RealEstateAgent", "RecyclingCenter", "SelfStorage", "ShoppingCenter", "SportsActivityLocation",
    "TelevisionStation", "TouristInformationCenter", "TravelAgency", "AccountingService", "AutomotiveBusiness",
    "BankOrCreditUnion", "BeautySalon", "Brewery", "Hospital", "Pharmacy",
}

ARTICLE_TYPES = {"Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle", "Report"}

ENTITY_DOMAINS = {
    "wikipedia.org", "wikidata.org", "linkedin.com", "crunchbase.com",
    "github.com", "x.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com",
}

_ART = {"required": ["headline", "image", "datePublished", "author"], "recommended": ["dateModified", "publisher", "description", "mainEntityOfPage"]}

RULES = {
    "Organization": {"required": ["name", "url"], "recommended": ["logo", "sameAs", "contactPoint", "description"]},
    "LocalBusiness": {"required": ["name", "address"], "recommended": ["telephone", "image", "url", "priceRange", "openingHours", "geo"]},
    "WebSite": {"required": ["name", "url"], "recommended": ["potentialAction", "description"]},
    "WebPage": {"required": ["name"], "recommended": ["description", "url"]},
    "Article": _ART, "BlogPosting": _ART, "NewsArticle": _ART,
    "Product": {"required": ["name", ("offers", "review", "aggregateRating")], "recommended": ["image", "description", "brand", "sku"]},
    "FAQPage": {"required": ["mainEntity"], "recommended": ["name"]},
    "BreadcrumbList": {"required": ["itemListElement"], "recommended": ["itemListOrder", "numberOfItems"]},
    "Person": {"required": ["name"], "recommended": ["url", "image", "jobTitle", "sameAs"]},
    "Event": {"required": ["name", "startDate", "location"], "recommended": ["endDate", "description", "image", "offers", "organizer"]},
    "Recipe": {"required": ["name", "image"], "recommended": ["recipeIngredient", "recipeInstructions", "prepTime", "cookTime", "totalTime"]},
    "HowTo": {"required": ["name", "step"], "recommended": ["image", "description", "totalTime"]},
    "VideoObject": {"required": ["name", "description", "thumbnailUrl", "uploadDate"], "recommended": ["contentUrl", "embedUrl", "duration"]},
    "Review": {"required": ["itemReviewed", "author", "reviewRating"], "recommended": ["reviewBody", "datePublished"]},
    "AggregateRating": {"required": ["ratingValue", ("ratingCount", "reviewCount")], "recommended": ["bestRating", "worstRating"]},
    "JobPosting": {"required": ["title", "description", "datePosted", "hiringOrganization", "jobLocation"], "recommended": ["validThrough", "employmentType", "baseSalary"]},
}


def types_of(node):
    """Return stripped schema.org type names for a node."""
    if not isinstance(node, dict):
        return []
    raw = node.get("@type")
    if not raw:
        return []
    res = []
    for it in (raw if isinstance(raw, list) else [raw]):
        if isinstance(it, str):
            clean = re.sub(r"^https?://schema\.org/", "", it.strip())
            if clean:
                res.append(clean)
    return res


def flatten_jsonld(objs):
    """Unwrap lists, @graph, and nested objects with an @type."""
    nodes, seen = [], set()

    def walk(val, is_top=True):
        if val is None:
            return
        if isinstance(val, list):
            for x in val:
                walk(x, is_top=is_top)
        elif isinstance(val, dict):
            vid = id(val)
            if vid in seen:
                return
            seen.add(vid)
            if "@graph" in val:
                walk(val["@graph"], is_top=True)
            has_type = "@type" in val
            has_content = any(k not in ("@context", "@graph") for k in val)
            if has_type or (is_top and has_content):
                nodes.append(val)
            for k, v in val.items():
                if k != "@graph":
                    walk(v, is_top=False)

    walk(objs, is_top=True)
    return nodes


def _resolve_type(t):
    if not t or not isinstance(t, str):
        return None
    if t in RULES:
        return t
    if t.endswith(("Business", "Store", "Restaurant")) or t in LOCAL_BUSINESS_SUBTYPES:
        return "LocalBusiness"
    if t in ("BlogPosting", "NewsArticle"):
        return "Article"
    return None


def _is_present(val):
    if val is None or val is False:
        return False
    if isinstance(val, (str, list, dict)):
        return len(val) > 0 and (not isinstance(val, str) or bool(val.strip()))
    return True


def _valid_offers(val):
    if not val:
        return False
    for it in (val if isinstance(val, list) else [val]):
        if isinstance(it, dict):
            has_p = ("price" in it and it["price"] is not None) or ("lowPrice" in it and it["lowPrice"] is not None)
            if has_p and bool(it.get("priceCurrency")):
                return True
    return False


def _valid_faq(val):
    if not val:
        return False
    for it in (val if isinstance(val, list) else [val]):
        if isinstance(it, dict) and (it.get("name") or it.get("text")):
            ans = it.get("acceptedAnswer")
            if (isinstance(ans, dict) and bool(ans.get("text"))) or (isinstance(ans, list) and any(isinstance(a, dict) and bool(a.get("text")) for a in ans)):
                return True
    return False


def _valid_breadcrumbs(val):
    if not val:
        return False
    for it in (val if isinstance(val, list) else [val]):
        if isinstance(it, dict) and it.get("position") is not None:
            if it.get("name") or (isinstance(it.get("item"), dict) and bool(it["item"].get("name"))):
                return True
    return False


def _check_prop(node, prop, type_name):
    if isinstance(prop, tuple):
        return any(_check_prop(node, p, type_name) for p in prop)
    if type_name == "Product" and prop == "offers":
        return _valid_offers(node.get("offers"))
    if type_name == "FAQPage" and prop == "mainEntity":
        return _valid_faq(node.get("mainEntity"))
    if type_name == "BreadcrumbList" and prop == "itemListElement":
        return _valid_breadcrumbs(node.get("itemListElement"))
    if type_name in ("Article", "BlogPosting", "NewsArticle") and prop == "headline":
        return _is_present(node.get("headline")) or _is_present(node.get("name"))
    return _is_present(node.get(prop))


def _parse_date(val):
    if not val or not isinstance(val, str):
        return None
    s = val.strip()
    try:
        return datetime.fromisoformat(s).date()
    except Exception:
        pass
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except Exception:
            pass
    return None


def _check(cid, group, title, status, score, weight, detail, data):
    return {
        "id": cid, "group": group, "title": title, "status": status,
        "score": float(score) if (status != "na" and score is not None) else None,
        "weight": float(weight), "detail": detail, "data": data or {},
    }


def schema_checks(page):
    p = page if isinstance(page, dict) else {}
    nodes = flatten_jsonld(p.get("jsonld"))
    micro = p.get("microdata_types") or []
    checks = []

    # 1. schema.present
    has_schema = bool(nodes or micro)
    checks.append(_check(
        "schema.present", "schema", "Structured Data Present",
        "pass" if has_schema else "fail", 1.0 if has_schema else 0.0, 2.0,
        f"Found {len(nodes)} JSON-LD node(s) and {len(micro)} microdata type(s)." if has_schema
        else "No JSON-LD or microdata structured data found on the page.",
        {"jsonld_nodes": len(nodes), "microdata_types": len(micro)},
    ))

    # 2. schema.valid_required & 3. schema.recommended
    tot_req, hit_req, tot_rec, hit_rec, known_cnt = 0, 0, 0, 0, 0
    missing_req, missing_rec = {}, {}
    for n in nodes:
        rtype = next((_resolve_type(t) for t in types_of(n) if _resolve_type(t)), None)
        if not rtype:
            continue
        known_cnt += 1
        rule = RULES[rtype]
        for req in rule.get("required", []):
            tot_req += 1
            if _check_prop(n, req, rtype):
                hit_req += 1
            else:
                lbl = " or ".join(req) if isinstance(req, tuple) else str(req)
                missing_req.setdefault(rtype, []).append(lbl)
        for rec in rule.get("recommended", []):
            tot_rec += 1
            if _check_prop(n, rec, rtype):
                hit_rec += 1
            else:
                missing_rec.setdefault(rtype, []).append(str(rec))

    if known_cnt == 0:
        checks.append(_check("schema.valid_required", "schema", "Required Schema Properties", "na", None, 3.0,
                             "No structured data nodes of known types to validate.", {"types_evaluated": 0, "missing": {}}))
        checks.append(_check("schema.recommended", "schema", "Recommended Schema Properties", "na", None, 1.0,
                             "No schema nodes with recommended properties to evaluate.", {"total_recommended": 0, "present_recommended": 0, "missing": {}}))
    else:
        req_sc = round(hit_req / tot_req, 3) if tot_req else 1.0
        req_st = "pass" if req_sc == 1.0 else ("warn" if req_sc >= 0.7 else "fail")
        req_clean = {k: sorted(set(v)) for k, v in missing_req.items()}
        req_det = (f"All {tot_req} required properties present across {known_cnt} node(s)." if req_sc == 1.0
                   else f"Missing required properties: {'; '.join(f'{k}: {', '.join(v)}' for k, v in req_clean.items())}.")
        checks.append(_check("schema.valid_required", "schema", "Required Schema Properties", req_st, req_sc, 3.0, req_det,
                             {"total_required": tot_req, "present_required": hit_req, "missing": req_clean}))

        rec_sc = round(hit_rec / tot_rec, 3) if tot_rec else 1.0
        rec_st = "pass" if rec_sc >= 0.7 else ("warn" if rec_sc >= 0.35 else "fail")
        rec_clean = {k: sorted(set(v)) for k, v in missing_rec.items()}
        rec_det = f"{hit_rec} of {tot_rec} recommended properties present across structured data nodes."
        checks.append(_check("schema.recommended", "schema", "Recommended Schema Properties", rec_st, rec_sc, 1.0, rec_det,
                             {"total_recommended": tot_rec, "present_recommended": hit_rec, "missing": rec_clean}))

    # 4. schema.organization
    org_nodes = [n for n in nodes if any(t == "Organization" or _resolve_type(t) == "LocalBusiness" for t in types_of(n))]
    if not org_nodes:
        checks.append(_check("schema.organization", "schema", "Organization Structured Data", "fail", 0.0, 1.0,
                             "No Organization or LocalBusiness structured data found.",
                             {"same_as_count": 0, "has_name": False, "has_url": False, "has_logo": False}))
    else:
        best_sc, best_m = -1, {}
        for org in org_nodes:
            hn, hu, hl = _is_present(org.get("name")), _is_present(org.get("url")), _is_present(org.get("logo"))
            sa = org.get("sameAs")
            scnt = len(sa) if isinstance(sa, list) else (1 if _is_present(sa) else 0)
            sc = sum([hn, hu, hl])
            if sc > best_sc:
                best_sc, best_m = sc, {"same_as_count": scnt, "has_name": hn, "has_url": hu, "has_logo": hl}
        org_sc = round(best_sc / 3.0, 3)
        org_st = "pass" if org_sc == 1.0 else ("warn" if org_sc > 0 else "fail")
        org_det = ("Organization structured data is complete with name, url, and logo." if org_sc == 1.0
                   else f"Organization structured data is missing: {', '.join(k for k in ['name', 'url', 'logo'] if not best_m[f'has_{k}'])}.")
        checks.append(_check("schema.organization", "schema", "Organization Structured Data", org_st, org_sc, 1.0, org_det, best_m))

    # 5. schema.breadcrumb
    path = urllib.parse.urlsplit(p.get("url") or "").path.strip()
    if path in ("", "/"):
        checks.append(_check("schema.breadcrumb", "schema", "Breadcrumb Structured Data", "na", None, 1.0,
                             "Breadcrumb schema is not required on the homepage.", {"is_home": True}))
    else:
        has_bc = any("BreadcrumbList" in types_of(n) for n in nodes) or any("BreadcrumbList" in t for t in micro)
        checks.append(_check("schema.breadcrumb", "schema", "Breadcrumb Structured Data",
                             "pass" if has_bc else "fail", 1.0 if has_bc else 0.0, 1.0,
                             "BreadcrumbList structured data found on internal page." if has_bc else "No BreadcrumbList structured data found on internal page.",
                             {"is_home": False, "present": has_bc}))

    return checks


def trust_checks(page, today_iso=None, site=None):
    p = page if isinstance(page, dict) else {}
    nodes = flatten_jsonld(p.get("jsonld"))
    site = site if isinstance(site, dict) else {}
    today_dt = _parse_date(today_iso) or date.today()
    checks = []

    # 1. trust.author
    is_art = any(any(t in ARTICLE_TYPES for t in types_of(n)) for n in nodes)
    word_count = p.get("word_count") or 0
    if not is_art and word_count < 300:
        checks.append(_check("trust.author", "trust", "Author Identity Signals", "na", None, 2.0,
                             "Page is not an article or long-form content; author check not applicable.",
                             {"word_count": word_count, "is_article": False}))
    else:
        auth_name, auth_src = None, None
        for n in nodes:
            a = n.get("author")
            names = [a.get("name")] if isinstance(a, dict) else ([x.get("name") if isinstance(x, dict) else x for x in a] if isinstance(a, list) else [a])
            for nm in names:
                if _is_present(nm):
                    auth_name, auth_src = str(nm), "jsonld"
                    break
            if auth_name:
                break
        if not auth_name and _is_present((p.get("meta") or {}).get("author")):
            auth_name, auth_src = str(p["meta"]["author"]), "meta"
        if not auth_name:
            for lk in (p.get("links") or []):
                if "author" in str(lk.get("rel") or "").lower().split():
                    auth_name, auth_src = lk.get("text") or lk.get("href"), "link"
                    break
        if not auth_name:
            m = re.search(r"\b[bB]y\s+([A-Z][a-zA-Z\.\'\-]{1,30}(?:\s+[A-Z][a-zA-Z\.\'\-]{1,30}){0,3})", (p.get("text") or "")[:300])
            if m:
                auth_name, auth_src = m.group(1).strip(), "byline"

        checks.append(_check(
            "trust.author", "trust", "Author Identity Signals",
            "pass" if auth_name else "fail", 1.0 if auth_name else 0.0, 2.0,
            f"Author identified via {auth_src}: {auth_name}." if auth_name else "No author found via JSON-LD, meta tags, rel=author, or byline.",
            {"author": auth_name, "source": auth_src},
        ))

    # Collect dates
    pub_d, mod_d, tag_d = [], [], []
    for n in nodes:
        dp, dm = _parse_date(n.get("datePublished")), _parse_date(n.get("dateModified"))
        if dp: pub_d.append(dp)
        if dm: mod_d.append(dm)
    meta = p.get("meta") or {}
    mp, mm = _parse_date(meta.get("article:published_time")), _parse_date(meta.get("article:modified_time"))
    if mp: pub_d.append(mp)
    if mm: mod_d.append(mm)
    for tt in (p.get("time_tags") or []):
        tval = _parse_date(tt)
        if tval: tag_d.append(tval)

    # 2. trust.dates
    all_d = pub_d + mod_d + tag_d
    if pub_d and mod_d:
        d_st, d_sc, d_det = "pass", 1.0, f"Publication date ({pub_d[0]}) and modification date ({mod_d[0]}) found."
    elif pub_d or mod_d:
        d_st, d_sc = "pass", 1.0
        d_det = f"Publication date found ({pub_d[0]})." if pub_d else f"Modification date found ({mod_d[0]})."
    elif tag_d:
        d_st, d_sc, d_det = "warn", 0.5, f"Date found from time tags ({tag_d[0]}), but missing structured schema dates."
    else:
        d_st, d_sc, d_det = "fail", 0.0, "No publication or modification dates found in schema, meta tags, or time elements."
    checks.append(_check("trust.dates", "trust", "Publication and Modification Dates", d_st, d_sc, 2.0, d_det,
                         {"published": [d.isoformat() for d in pub_d], "modified": [d.isoformat() for d in mod_d], "time_tags": [d.isoformat() for d in tag_d]}))

    # 3. trust.freshness
    valid_d = [d for d in all_d if (d - today_dt).days <= 2]
    if not valid_d:
        checks.append(_check("trust.freshness", "trust", "Content Freshness Evaluation", "na", None, 1.0,
                             "No valid dates found to evaluate content freshness.", {"newest_date": None, "days_old": None}))
    else:
        newest = max(valid_d)
        days_old = max(0, (today_dt - newest).days)
        f_st = "pass" if days_old <= 365 else ("warn" if days_old <= 730 else "fail")
        f_sc = 1.0 if days_old <= 365 else (0.5 if days_old <= 730 else 0.0)
        f_det = (f"Content is fresh ({days_old} days old, dated {newest.isoformat()})." if days_old <= 365
                 else (f"Content is moderately old ({days_old} days old, dated {newest.isoformat()}). Consider updating." if days_old <= 730
                       else f"Content is over 2 years old ({days_old} days old, dated {newest.isoformat()}). Fresh content ranks better."))
        checks.append(_check("trust.freshness", "trust", "Content Freshness Evaluation", f_st, f_sc, 1.0, f_det,
                             {"newest_date": newest.isoformat(), "days_old": days_old, "threshold_days": 365}))

    # 4. trust.site_pages
    ab, ct, pr = bool(site.get("about")), bool(site.get("contact")), bool(site.get("privacy"))
    site_sc = round(sum([ab, ct, pr]) / 3.0, 3)
    site_st = "pass" if site_sc == 1.0 else ("warn" if site_sc > 0 else "fail")
    site_det = ("All essential trust pages linked (About, Contact, Privacy)." if site_sc == 1.0
                else (f"Missing links to essential pages: {', '.join(k for k, ok in [('About', ab), ('Contact', ct), ('Privacy', pr)] if not ok)}." if site_sc > 0
                      else "No links to About, Contact, or Privacy policy pages found."))
    checks.append(_check("trust.site_pages", "trust", "Trust and Policy Pages", site_st, site_sc, 1.0, site_det,
                         {"about": ab, "contact": ct, "privacy": pr, "share": site_sc}))

    # 5. trust.entity_links
    ent_nodes = [n for n in nodes if any(t in ("Organization", "Person") or _resolve_type(t) == "LocalBusiness" for t in types_of(n))]
    matched_doms = set()
    for en in ent_nodes:
        sa = en.get("sameAs")
        for u in (sa if isinstance(sa, list) else ([sa] if isinstance(sa, str) else [])):
            if isinstance(u, str):
                try:
                    host = urllib.parse.urlsplit(u.strip()).netloc.lower().split(":")[0]
                    for d in ENTITY_DOMAINS:
                        if host == d or host.endswith("." + d):
                            matched_doms.add("x.com" if d == "twitter.com" else d)
                except Exception:
                    pass
    ent_cnt = len(matched_doms)
    has_ent = bool(ent_nodes)
    if ent_cnt >= 2:
        el_st, el_sc, el_det = "pass", 1.0, f"Found {ent_cnt} authoritative entity profile link(s) ({', '.join(sorted(matched_doms))})."
    elif ent_cnt == 1:
        el_st, el_sc, el_det = "warn", 0.5, f"Found 1 authoritative entity profile link ({list(matched_doms)[0]}). Add more authoritative profiles."
    else:
        el_st, el_sc = ("fail" if has_ent else "warn"), 0.0
        el_det = ("Entity schema has no authoritative sameAs links to Wikipedia, LinkedIn, X, etc." if has_ent
                  else "No Organization or Person schema found to verify entity links.")
    checks.append(_check("trust.entity_links", "trust", "Entity Authority Links", el_st, el_sc, 1.0, el_det,
                         {"count": ent_cnt, "matched": sorted(matched_doms), "has_entity_node": has_ent}))

    return checks


def audit(page, today_iso=None, site=None):
    return schema_checks(page) + trust_checks(page, today_iso=today_iso, site=site)
