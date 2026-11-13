export const meta = {
  task: 'AU-asx.com.au',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'symbol', 'industry', 'date_listed'],
  canary: { found: 'COMMONWEALTH BANK OF AUSTRALIA.', not_found: 'ZORBLAX PHANTOM HOLDINGS PTY LTD' },
};

// The ASX company directory (the list behind https://www.asx.com.au/markets/trade-our-cash-market/directory) is
// served by the site's own research API: 25 companies per page, page numbers from 0, with a total "count".
const API = 'https://asx.api.cmfyapp.com/asx-research/1.0/companies/directory';
const PUBLIC_PAGE = 'https://www.asx.com.au/markets/trade-our-cash-market/directory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Origin': 'https://www.asx.com.au', 'Referer': 'https://www.asx.com.au/' };
const CONCURRENCY = 8;
const OVERALL_MS = 50000; // stay well under the 60 s limit

// Legal-form words that are dropped from the end of a name before comparing.
const LEGAL_FORM = new Set(['LIMITED', 'LTD', 'PTY', 'NL', 'INC', 'INCORPORATED', 'PLC', 'LLC', 'CORP', 'CORPORATION', 'LP']);

/** Upper-case, strip accents and punctuation, drop trailing legal-form words. */
function normalizeName(str) {
  let s = (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
  s = s.replace(/&/g, ' AND ').replace(/\bNO LIABILITY\b/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORM.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PUBLIC_PAGE, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Fetch one directory page. Returns { ok: true, data } or { ok: false, reason, excerpt }. */
async function fetchPage(page) {
  // The API sometimes answers 500 for a single page; retry twice before giving up on that page.
  let res;
  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1000));
    try {
      res = await fetch(`${API}?page=${page}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      text = await res.text();
    } catch (err) {
      if (attempt === 2) throw err;
      continue;
    }
    if (res.status < 500) break;
  }
  if (res.status === 403 || res.status === 429 || /Incapsula|Request unsuccessful/i.test(text.slice(0, 2000))) {
    return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status} on page ${page}` };
  }
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status} on page ${page}` };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, reason: 'layout_changed', excerpt: text.slice(0, 200) }; }
  if (!data || !data.data || !Array.isArray(data.data.items)) {
    return { ok: false, reason: 'layout_changed', excerpt: text.slice(0, 200) };
  }
  return { ok: true, data: data.data };
}

async function crawl(keyword) {
  const first = await fetchPage(0);
  if (!first.ok) return fail(first.reason, first.excerpt);

  const count = first.data.count;
  const pageSize = first.data.items.length;
  if (!Number.isInteger(count) || count < 0 || (count > 0 && pageSize === 0)) {
    return fail('layout_changed', `unexpected count ${count} / page size ${pageSize}`);
  }
  const pages = pageSize ? Math.ceil(count / pageSize) : 0;
  const results = new Array(pages).fill(null);
  results[0] = first.data.items;

  let next = 1;
  let failure = null;
  const worker = async () => {
    while (!failure && next < pages) {
      const p = next++;
      const r = await fetchPage(p);
      if (!r.ok) { failure = r; return; }
      results[p] = r.data.items;
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(CONCURRENCY, pages - 1)) }, worker));
  if (failure) return fail(failure.reason, failure.excerpt);

  const all = results.flat();
  // A short list would hide matches, so an incomplete crawl is never reported as not_found.
  if (all.length !== count) return fail('other', `collected ${all.length} of ${count} directory entries`);

  const kwNorm = normalizeName(keyword);
  const matches = all.filter((it) => normalizeName(it.displayName) === kwNorm);

  if (matches.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PUBLIC_PAGE,
      excerpt: `No match for "${keyword}" among ${count} companies on the ASX directory (${pages} pages checked)`,
    };
  }

  return {
    status: 'found',
    reason: '',
    records: matches.map((it) => ({
      name: it.displayName,
      symbol: it.symbol,
      industry: it.industry,
      date_listed: it.dateListed,
    })),
    source_url: PUBLIC_PAGE,
    excerpt: matches.map((it) => `${it.displayName} | ASX code ${it.symbol} | ${it.industry} | listed ${it.dateListed}`).join(' ; ').slice(0, 300),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (!normalizeName(keyword)) return fail('other', 'empty company name');
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(fail('timeout', `the ASX directory check did not finish in ${OVERALL_MS / 1000} s`)), OVERALL_MS);
    });
    try {
      return await Promise.race([crawl(String(keyword)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    const reason = /abort|timeout/i.test(msg) ? 'timeout' : 'other';
    return fail(reason, msg);
  }
}
