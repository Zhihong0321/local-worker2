export const meta = {
  task: 'CA-orgbook.gov.bc.ca',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'business_number', 'status', 'entity_type', 'jurisdiction', 'registration_date', 'status_effective_date', 'revoked', 'all_names', 'entity_url'],
  canary: { found: 'UNIVERSAL SPICES LTEE', not_found: 'Zqxwvkjb Brllmnq Ltée' },
};

// BC OrgBook public search API (the same JSON API the OrgBook web app calls in the browser). No login, no token.
const API = 'https://orgbook.gov.bc.ca/api/v4/search/topic';
const SITE = 'https://www.orgbook.gov.bc.ca';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 50;
const MAX_PAGES = 2; // worst case 2 x 25 s fetch timeout stays under the 60 s limit
const TIMEOUT_MS = 25000;

// Legal-form words, already folded (upper case, no accents or punctuation).
const LEGAL_FORMS = new Set(['LTD', 'LIMITED', 'LTEE', 'LTE', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO',
  'COMPANY', 'LLC', 'LLP', 'LP', 'ULC', 'SDN', 'BHD']);

/** Upper case, accents removed, '&' as AND, every other symbol removed. "Ltée" -> "LTEE". */
function fold(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Name tokens with trailing legal-form words removed ("UNIVERSAL SPICES LTEE" -> ["UNIVERSAL", "SPICES"]). */
function coreTokens(str) {
  const t = fold(str).split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

/** The text sent to the search: the name as typed, minus trailing legal-form words. */
function searchText(keyword) {
  const words = String(keyword || '').replace(/[.,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

function searchUrl(q, page) {
  const p = new URLSearchParams({ q, page: String(page), page_size: String(PAGE_SIZE) });
  return `${API}?${p.toString()}`;
}

function attr(result, type) {
  const a = (result.attributes || []).find((x) => x.type === type);
  return a ? a.value : '';
}

function toRecord(result, matchedName) {
  const bn = (result.names || []).find((n) => n.type === 'business_number');
  return {
    name: matchedName,
    registration_number: result.source_id || '',
    business_number: bn ? bn.text : '',
    status: attr(result, 'entity_status'),
    status_effective_date: attr(result, 'entity_status_effective'),
    entity_type: attr(result, 'entity_type'),
    jurisdiction: attr(result, 'home_jurisdiction'),
    registration_date: attr(result, 'registration_date'),
    revoked: !!result.revoked,
    all_names: (result.names || []).filter((n) => n.type === 'entity_name').map((n) => n.text),
    entity_url: `${SITE}/entity/${result.source_id}`,
  };
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: couldnt(timedOut ? 'timeout' : 'other', url, `fetch failed: ${e && e.message ? e.message : e}`) };
  }
  if (res.status === 403 || res.status === 429) return { fail: couldnt('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: couldnt('http_error', url, `HTTP ${res.status}`) };

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (/captcha|access denied|incapsula|request unsuccessful/i.test(text)) return { fail: couldnt('blocked', url, text.slice(0, 200)) };
    return { fail: couldnt('layout_changed', url, `not JSON: ${text.slice(0, 200)}`) };
  }
  if (!json || !Array.isArray(json.results) || typeof json.total !== 'number') {
    return { fail: couldnt('layout_changed', url, `unexpected JSON: ${text.slice(0, 200)}`) };
  }
  return { data: json };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const firstUrl = searchUrl(searchText(keyword), 1);
  try {
    const wanted = coreTokens(keyword).join(' ');
    if (!wanted) return couldnt('other', firstUrl, 'empty company name');

    const q = searchText(keyword);
    const matches = [];
    let total = null;
    let scanned = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const got = await fetchPage(searchUrl(q, page));
      if (got.fail) return { ...got.fail, source_url: firstUrl };
      const j = got.data;
      total = j.total;
      for (const r of j.results) {
        const hit = (r.names || []).find((n) => n.type === 'entity_name' && coreTokens(n.text).join(' ') === wanted);
        if (hit) matches.push(toRecord(r, hit.text));
      }
      scanned += j.results.length;
      if (j.results.length === 0 || scanned >= total) break;
    }

    if (matches.length > 0) {
      const first = matches[0];
      const excerpt = matches.slice(0, 3)
        .map((m) => `${m.name} | ${m.registration_number} | status ${m.status} | ${m.jurisdiction} | registered ${m.registration_date}`)
        .join(' || ');
      return { status: 'found', reason: '', records: matches, source_url: firstUrl, excerpt };
    }

    if (scanned >= total) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `0 matching names for "${keyword}" (${total} results for "${q}")` };
    }

    // The site returned more results than were read and none matched exactly: not proven absent.
    return couldnt('other', firstUrl, `no exact match in the first ${scanned} of ${total} results for "${q}"`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', firstUrl, String((err && err.message) || err));
  }
}
