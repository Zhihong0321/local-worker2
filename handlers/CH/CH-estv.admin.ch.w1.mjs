export const meta = {
  task: 'CH-estv.admin.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['uid', 'name', 'legal_form', 'uid_status', 'hr_status', 'street', 'postcode_city', 'canton', 'municipality',
    'mwst_number', 'mwst_status', 'mwst_begin', 'mwst_end', 'mwst_group_uid'],
  canary: { found: 'Nestlé AG', not_found: 'Zzqwertbau Nichtexistierend GmbH' },
};

// The ESTV VAT data is shown in the Swiss UID register (linked from estv.admin.ch). Flow:
// 1) GET Search.aspx (ASP.NET hidden tokens + session cookie)
// 2) POST the name search with those tokens; result rows carry a postback button per UID
// 3) POST that button (postback) -> address picker with Detail.aspx links, or the detail itself
// 4) GET each Detail.aspx page -> UID, status, address, MWST fields
const SITE = 'https://www.uid.admin.ch';
const SEARCH_URL = SITE + '/Search.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 25000;
const SOFT_DEADLINE = 30000; // no new step after this; a step that starts just before it ends within 25 s, so the call stays under 60 s
const MAX_UIDS = 3;
const MAX_DETAILS = 6;

// Swiss and common legal-form words, removed before comparing names.
const LEGAL_WORDS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'llc', 'ltd', 'inc', 'kg', 'co', 'corp', 'plc', 'se',
  'aktiengesellschaft', 'gesellschaft', 'mit', 'beschrankter', 'beschraenkter', 'haftung', 'societe', 'anonyme',
  'cie', 'et', 'und', 'limited', 'company', 'corporation', 'genossenschaft', 'stiftung', 'verein', 'holding']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function stripTags(html) {
  return decodeEntities((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, accents, punctuation and legal form removed. */
function core(name) {
  const s = decodeEntities(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').toLowerCase();
  return s.split(/[^a-z0-9]+/).filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function takeCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

async function request(url, jar, form) {
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'de-CH,de;q=0.9,fr;q=0.8,en;q=0.7' };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers.Referer = SEARCH_URL;
  }
  const res = await fetch(url, {
    method: form ? 'POST' : 'GET',
    headers,
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  takeCookies(res, jar);
  return { status: res.status, ok: res.ok, text: await res.text() };
}

/** Standard ASP.NET hidden inputs (__VIEWSTATE, __EVENTVALIDATION, csrf token, ...). */
function hiddenFields(html) {
  const f = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const n = tag.match(/\bname="([^"]*)"/i);
    if (!n) continue;
    const v = tag.match(/\bvalue="([^"]*)"/i);
    f[decodeEntities(n[1])] = v ? decodeEntities(v[1]) : '';
  }
  return f;
}

/** Result grid rows: postback target of the details button plus the eight grid cells. */
function parseRows(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr\b[^>]*class="rg(?:Alt)?Row"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 8) continue;
    const target = (cells[0].match(/WebForm_PostBackOptions\((?:&quot;|")([^&"]+)(?:&quot;|")/i) || [])[1] || '';
    const t = cells.map(stripTags);
    rows.push({ target, uid: t[1], name: t[2], status: t[3], place: t[4], extra: t[5], office: t[6] });
  }
  return rows;
}

/** Value shown next to a field label in the detail page: the first value box before the next label. */
function fieldValue(html, label) {
  const re = new RegExp('>\\s*' + escapeRe(label) + '\\s*</label>', 'i');
  const m = re.exec(html);
  if (!m) return '';
  const rest = html.slice(m.index + m[0].length);
  const next = rest.search(/<label\b/i);
  const seg = next >= 0 ? rest.slice(0, next) : rest;
  const d = seg.match(/<div style="padding:7px 12px">([\s\S]*?)<\/div>/i);
  return d ? stripTags(d[1]) : '';
}

function parseDetail(html, url) {
  const uid = (fieldValue(html, 'UID').match(/CHE-\d{3}\.\d{3}\.\d{3}/) || [''])[0];
  const mwst = (fieldValue(html, 'MWST-Nummer').match(/CHE-\d{3}\.\d{3}\.\d{3}/) || [''])[0];
  return {
    uid,
    name: fieldValue(html, 'Name'),
    legal_form: fieldValue(html, 'Rechtsform'),
    uid_status: fieldValue(html, 'UID-Status'),
    hr_status: fieldValue(html, 'Status HR'),
    street: fieldValue(html, 'Strasse / Nr.'),
    postcode_city: fieldValue(html, 'PLZ / Ort'),
    canton: fieldValue(html, 'Kanton'),
    municipality: fieldValue(html, 'Gemeinde'),
    mwst_number: mwst,
    mwst_status: fieldValue(html, 'Status MWST-Register'),
    mwst_begin: fieldValue(html, 'Beginn MWST-Pflicht'),
    mwst_end: fieldValue(html, 'Ende MWST-Pflicht'),
    mwst_group_uid: fieldValue(html, 'UID der MWST-Gruppe'),
    source_url: url,
  };
}

function isDetailPage(html) {
  return /Kernmerkmale/.test(html) && /UID-Status/.test(html);
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const late = () => Date.now() - t0 > SOFT_DEADLINE;
  const jar = new Map();
  let step = 'start';
  try {
    const kw = String(keyword || '').trim();
    const wanted = core(kw);
    if (!wanted) return fail('other', SEARCH_URL, 'empty or unusable company name');

    // 1) search page for the tokens
    step = 'search page';
    const page = await request(SEARCH_URL, jar);
    if (page.status === 403 || page.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${page.status}`);
    if (!page.ok) return fail('http_error', SEARCH_URL, `HTTP ${page.status}`);
    if (!/name="ctl00\$cphContent\$ctl02\$txtSearch"/.test(page.text) || !/name="__VIEWSTATE"/.test(page.text)) {
      return fail('layout_changed', SEARCH_URL, page.text.slice(0, 300));
    }

    // 2) name search
    if (late()) return fail('timeout', SEARCH_URL, 'stopped before the search');
    step = 'search';
    const fields = hiddenFields(page.text);
    fields['ctl00$cphContent$ctl02$txtSearch'] = kw;
    fields['ctl00$cphContent$btnSearch'] = 'Suchen';
    const result = await request(SEARCH_URL, jar, fields);
    if (result.status === 403 || result.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${result.status}`);
    if (!result.ok) return fail('http_error', SEARCH_URL, `HTTP ${result.status}`);

    const rows = parseRows(result.text);
    const noHits = /existiert nicht oder ist nicht/i.test(result.text);
    if (rows.length === 0) {
      if (noHits) return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: 'UID register search: 0 results for ' + kw };
      return fail('layout_changed', SEARCH_URL, stripTags(result.text).slice(0, 300));
    }

    const pagerTotal = parseInt((result.text.match(/rgPagerLabel"[^>]*>\s*von\s+(\d+)/i) || [])[1] || '1', 10);
    const hits = [];
    const seenUid = new Set();
    for (const r of rows) {
      if (!r.target || !r.uid || core(r.name) !== wanted || seenUid.has(r.uid)) continue;
      seenUid.add(r.uid);
      hits.push(r);
    }
    if (hits.length === 0) {
      if (pagerTotal > 1) {
        return fail('other', SEARCH_URL, `no exact name match on page 1 of ${pagerTotal} results`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `UID register search: ${rows.length} result(s) for ${kw}, none with this name` };
    }

    // 3) + 4) open each matching UID: postback -> address picker -> detail pages
    const searchFields = hiddenFields(result.text);
    const details = [];
    const detailUrls = new Set();
    for (const hit of hits.slice(0, MAX_UIDS)) {
      if (late()) return fail('timeout', SEARCH_URL, `stopped before opening ${hit.uid}`);
      step = 'open ' + hit.uid;
      const pf = { ...searchFields, __EVENTTARGET: hit.target, __EVENTARGUMENT: '' };
      const opened = await request(SEARCH_URL, jar, pf);
      if (opened.status === 403 || opened.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${opened.status}`);
      if (!opened.ok) return fail('http_error', SEARCH_URL, `HTTP ${opened.status}`);

      const urls = [];
      if (isDetailPage(opened.text)) {
        urls.push(null); // the postback already returned the detail page
      } else {
        for (const m of opened.text.matchAll(/Detail\.aspx\?uid_id=([A-Z0-9.\-]+)&(?:amp;)?ehra_id=(\d+)/gi)) {
          const u = `${SITE}/Detail.aspx?uid_id=${m[1]}&ehra_id=${m[2]}`;
          if (!urls.includes(u)) urls.push(u);
        }
      }
      if (urls.length === 0) return fail('layout_changed', SEARCH_URL, `no detail links after opening ${hit.uid}`);

      for (const u of urls) {
        if (details.length >= MAX_DETAILS) break;
        if (late()) return fail('timeout', SEARCH_URL, 'stopped before all detail pages');
        let html = opened.text;
        let url = SEARCH_URL;
        if (u) {
          step = 'detail';
          const d = await request(u, jar);
          if (d.status === 403 || d.status === 429) return fail('blocked', u, `HTTP ${d.status}`);
          if (!d.ok) return fail('http_error', u, `HTTP ${d.status}`);
          html = d.text;
          url = u;
        } else {
          url = SEARCH_URL;
        }
        if (!isDetailPage(html)) return fail('layout_changed', url, stripTags(html).slice(0, 300));
        const rec = parseDetail(html, url);
        if (!rec.uid || core(rec.name) !== wanted) continue;
        if (!detailUrls.has(url + '|' + rec.uid + '|' + rec.street)) {
          detailUrls.add(url + '|' + rec.uid + '|' + rec.street);
          details.push(rec);
        }
      }
    }

    if (details.length === 0) return fail('layout_changed', SEARCH_URL, 'matching UID opened but no detail record had this name');

    const first = details[0];
    return {
      status: 'found',
      reason: '',
      records: details,
      source_url: first.source_url,
      excerpt: `${first.name} | ${first.uid} | UID status: ${first.uid_status} | MWST: ${first.mwst_number || 'none shown'}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SEARCH_URL, `${step}: ${String(err && err.message || err)}`);
  }
}
