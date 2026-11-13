// 104 Job Bank (104.com.tw) company lookup.
// The company search page is a Vue app; its results come from a public JSON list endpoint:
//   https://www.104.com.tw/company/ajax/list?keyword=<name>&page=<n>&pageSize=12
// Each result carries the company's name and its public profile fields. Matching is done here by comparing
// normalised names (width, case, punctuation, legal form), so a fuzzy result list is never taken as a match.

export const meta = {
  task: 'TW-104.com.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'encoded_cust_no', 'area', 'industry', 'capital', 'employee_count', 'open_jobs', 'url'],
  canary: { found: '台灣積體電路製造股份有限公司(台積電)', not_found: '龍騰虛構科技股份有限公司' },
};

const BASE = 'https://www.104.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 12;
const MAX_PAGES = 2; // page 1, plus page 2 only when page 1 has no match and more pages exist

// Taiwan and common English legal-form words, removed before comparing names.
const LEGAL_FORMS = /股份有限公司|有限公司|股份有限|有限責任|株式會社|公司|ltd|limited|inc|corp/g;

/** Normalised form of a name: NFKC, lower case, no spaces or punctuation, no legal form. */
function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(LEGAL_FORMS, '');
}

/** Does a 104 company name refer to the keyword's company? Matches the full name, the name outside the brackets,
 *  or a name inside the brackets (104 writes the short name in brackets, e.g. "...(台積電)"). */
function isSameCompany(keyword, recordName) {
  const k = norm(keyword);
  if (!k) return false;
  const full = String(recordName || '');
  const outer = norm(full.replace(/[(（][^)）]*[)）]/g, ''));
  const inner = [...full.matchAll(/[(（]([^)）]*)[)）]/g)].map((m) => norm(m[1])).filter(Boolean);
  return k === norm(full) || k === outer || inner.includes(k);
}

function toRecord(r) {
  const id = String(r.encodedCustNo || '');
  return {
    name: String(r.name || ''),
    encoded_cust_no: id,
    area: String(r.areaDesc || ''),
    industry: String(r.industryDesc || ''),
    capital: String(r.capitalDesc || ''),
    employee_count: String(r.employeeCountDesc || ''),
    open_jobs: typeof r.jobCount === 'number' ? r.jobCount : null,
    url: id ? `${BASE}/company/${id}` : '',
  };
}

function searchPageUrl(keyword) {
  return `${BASE}/company/search/?keyword=${encodeURIComponent(keyword)}`;
}

/** Fetch one page of the list endpoint. Returns { json } on success or { fail } with a couldnt_check answer. */
async function fetchListPage(keyword, page) {
  const apiUrl = `${BASE}/company/ajax/list?keyword=${encodeURIComponent(keyword)}&page=${page}&pageSize=${PAGE_SIZE}`;
  const res = await fetch(apiUrl, {
    signal: AbortSignal.timeout(25000),
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      'Referer': searchPageUrl(keyword),
    },
  });
  const text = await res.text();
  const source_url = searchPageUrl(keyword);

  if (res.status === 403 || res.status === 429) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${res.status}` } };
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || typeof json !== 'object') {
    // Not JSON: a bot check or challenge page is "blocked"; anything else means the layout changed.
    if (/challenge|captcha|cf-chl|just a moment|access denied/i.test(text)) {
      return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: 'bot check page' } };
    }
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) } };
  }
  if (!Array.isArray(json.data) || !json.metadata || !json.metadata.pagination) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) } };
  }
  return { json };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword ?? '').trim();
  const source_url = searchPageUrl(kw);
  try {
    if (!norm(kw)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'empty company name' };
    }

    const first = await fetchListPage(kw, 1);
    if (first.fail) return first.fail;

    const matches = [];
    let total = first.json.data.length;
    const seen = first.json.data;
    matches.push(...seen.filter((r) => isSameCompany(kw, r.name)));
    const lastPage = Number(first.json.metadata.pagination.lastPage) || 1;

    for (let page = 2; matches.length === 0 && page <= Math.min(lastPage, MAX_PAGES); page++) {
      const next = await fetchListPage(kw, page);
      if (next.fail) return next.fail;
      total += next.json.data.length;
      matches.push(...next.json.data.filter((r) => isSameCompany(kw, r.name)));
    }

    if (matches.length > 0) {
      const records = matches.map(toRecord);
      const top = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: top.url || source_url,
        excerpt: `${top.name} | ${top.area} | ${top.industry} | ${top.capital} | ${top.employee_count}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: `0 of ${total} search results match "${kw}"`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
