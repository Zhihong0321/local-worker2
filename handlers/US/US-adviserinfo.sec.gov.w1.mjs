export const meta = {
  task: 'US-adviserinfo.sec.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'crd', 'sec_number', 'ia_status', 'bd_status', 'address', 'other_names', 'disclosure', 'branches', 'firm_url'],
  canary: { found: 'VANGUARD ADVISERS, INC.', not_found: 'Xqzvbwr Holdings LLC' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://api.adviserinfo.sec.gov/search/firm';
const FIRM_PAGE = 'https://adviserinfo.sec.gov/firm/summary/';
const PAGE_SIZE = 20;
const MAX_SCAN = 40; // two pages of 20 hits
const LEGAL_TOKENS = new Set(['llc', 'inc', 'incorporated', 'ltd', 'limited', 'lp', 'llp', 'corp', 'corporation', 'co']);

/** Lower case, "&" as "and", punctuation removed, trailing legal-form words removed, spaces removed. */
function normalize(str) {
  const tokens = String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

function parseAddress(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const a = o && o.officeAddress;
    if (!a) return '';
    return [a.street1, a.street2, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

function toRecord(src) {
  return {
    name: src.firm_name || src.ia_firm_name || '',
    crd: String(src.firm_source_id || ''),
    sec_number: src.firm_ia_full_sec_number || src.firm_bd_full_sec_number || '',
    ia_status: src.firm_ia_scope || '',
    bd_status: src.firm_scope || '',
    address: parseAddress(src.firm_ia_address_details),
    other_names: Array.isArray(src.firm_other_names) ? src.firm_other_names : [],
    disclosure: src.firm_ia_disclosure_fl || src.firm_disclosure_fl || '',
    branches: src.firm_branches_count ?? null,
    firm_url: FIRM_PAGE + (src.firm_source_id || ''),
  };
}

function matches(src, wanted) {
  const names = [src.firm_name, src.ia_firm_name, ...(Array.isArray(src.firm_other_names) ? src.firm_other_names : [])];
  return names.some((n) => normalize(n) === wanted);
}

function fail(reason, searchUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const wanted = normalize(keyword);
  const firstUrl = `${SEARCH}?query=${encodeURIComponent(String(keyword))}&from=0`;
  try {
    if (!wanted) return fail('other', firstUrl, 'empty company name');

    const hits = [];
    let total = 0;
    let scanned = 0;
    let matched = [];

    for (let from = 0; from < MAX_SCAN; from += PAGE_SIZE) {
      const url = `${SEARCH}?query=${encodeURIComponent(String(keyword))}&from=${from}`;
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      const looksHtml = !text.trimStart().startsWith('{') && /captcha|just a moment|access denied|challenge/i.test(text.slice(0, 2000));
      if (looksHtml) return fail('blocked', url, text.slice(0, 200));

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return fail('layout_changed', url, text.slice(0, 200));
      }
      if (json.errorCode !== undefined || !json.hits || !Array.isArray(json.hits.hits)) {
        return fail('layout_changed', url, text.slice(0, 200));
      }

      total = Number(json.hits.total) || 0;
      const page = json.hits.hits.map((h) => h._source).filter(Boolean);
      hits.push(...page);
      scanned = from + page.length;
      matched = hits.filter((src) => matches(src, wanted));
      if (matched.length) break;
      if (page.length < PAGE_SIZE || scanned >= total) break;
    }

    if (matched.length) {
      const records = matched.map(toRecord);
      return {
        status: 'found',
        reason: '',
        records,
        source_url: `${SEARCH}?query=${encodeURIComponent(String(keyword))}&from=0`,
        excerpt: `${records.length} record(s) for ${records[0].name}; CRD ${records[0].crd}; IA status ${records[0].ia_status || 'n/a'}`,
      };
    }

    if (total > scanned) {
      // Results exist beyond the scanned pages: absence is not proven.
      return fail('other', firstUrl, `no exact name match in the first ${scanned} of ${total} results`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 exact matches for "${keyword}" (search total ${total})`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, firstUrl, String((err && err.message) || err));
  }
}
