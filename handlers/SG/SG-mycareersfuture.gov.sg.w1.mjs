export const meta = { task: 'SG-mycareersfuture.gov.sg', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'uen', 'ssic_code', 'ssic_description', 'registered_address', 'last_sync_date'],
  canary: { found: 'DBS BANK LTD.', not_found: '新加坡虚构贸易有限公司' } };

// MyCareersFuture's public company directory (the JSON API behind the site's employer pages).
// `name` is a case-insensitive "contains" filter; `limit` is capped at 100; `page` is 0-based.
const API = 'https://api.mycareersfuture.gov.sg/v2/companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;          // the API's maximum page size
const MAX_PAGES = 30;      // 3,000 candidate rows per query; beyond that we cannot check every row
const BUDGET_MS = 45000;   // stay well under the 60 s limit for the whole call

const LEGAL_WORDS = new Set(['PTE', 'PTE.', 'LTD', 'LTD.', 'LIMITED', 'PRIVATE', 'PVT', 'PVT.', 'LLP', 'LLC', 'SDN', 'BHD', 'BHD.', 'PLC']);

/** Normalise a company name for comparison: case, punctuation, spacing and legal-form spelling. */
function normalise(name) {
  let t = String(name || '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  // Same legal form, different spelling: "Private Limited" = "Pte Ltd"; "Pte. Ltd." = "PTE LTD".
  t = t.replace(/\bPRIVATE LIMITED\b/g, 'PTE LTD')
    .replace(/\bPRIVATE LTD\b/g, 'PTE LTD')
    .replace(/\bPVT\b/g, 'PTE')
    .replace(/\bLIMITED\b/g, 'LTD');
  return t.replace(/ /g, '');
}

/** Search strings to send to the API: the name without its trailing legal form, as typed and punctuation-free. */
function searchBases(keyword) {
  const words = String(keyword || '').trim().replace(/\s+/g, ' ').split(' ');
  while (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1].toUpperCase())) words.pop();
  const base = words.join(' ');
  const alnum = base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return [...new Set([base, alnum].filter(Boolean))];
}

function formatAddress(a) {
  return [
    [a.block, a.street].filter(Boolean).join(' '),
    a.building,
    a.floor ? `Floor ${a.floor}` : '',
    a.unit ? `Unit ${a.unit}` : '',
    a.postalCode ? `Singapore ${a.postalCode}` : '',
  ].filter(Boolean).join(', ');
}

/** GET one JSON URL. Returns { body } or { fail, excerpt }. Never throws. */
async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { body: JSON.parse(text) };
    } catch {
      return { fail: 'layout_changed', excerpt: 'response is not JSON: ' + text.slice(0, 200) };
    }
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
  }
}

/** Page through every row whose name contains `query`. */
async function searchAll(query, deadline) {
  const rows = [];
  let url = '';
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > deadline) return { rows, total, url, fail: 'timeout', excerpt: 'time budget used up while paging' };
    url = `${API}?name=${encodeURIComponent(query)}&limit=${PAGE}&page=${page}`;
    const r = await fetchJson(url);
    if (r.fail) return { rows, total, url, fail: r.fail, excerpt: r.excerpt };
    const b = r.body;
    if (!b || !Array.isArray(b.results) || typeof b.total !== 'number') {
      return { rows, total, url, fail: 'layout_changed', excerpt: JSON.stringify(b).slice(0, 200) };
    }
    rows.push(...b.results);
    total = b.total;
    if (b.results.length === 0 || rows.length >= total) return { rows, total, url, truncated: false };
  }
  return { rows, total, url, truncated: rows.length < total };
}

/** Build one record from a search row, adding the registered address from the detail record. */
async function toRecord(row, deadline) {
  const rec = {
    name: row.name || '',
    uen: row.uen || '',
    ssic_code: row.ssicCode2020 || row.ssicCode || '',
    ssic_description: String(row.ssicDescription2020 || '').trim(),
    registered_address: '',
    last_sync_date: row.lastSyncDate || '',
    source_url: `${API}/${encodeURIComponent(row.uen)}`,
  };
  if (Date.now() > deadline) return { ...rec, detail_error: 'skipped: time budget used up' };
  const r = await fetchJson(rec.source_url);
  if (r.fail) return { ...rec, detail_error: `${r.fail}: ${r.excerpt}` };
  const addrs = Array.isArray(r.body?.addresses) ? r.body.addresses : [];
  const addr = addrs.find(a => a.purpose === 'registered') || addrs[0];
  if (addr) rec.registered_address = formatAddress(addr);
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // On this Windows Node build, a process that exits right after a fetch can abort with exit 127 while the
  // connection pool closes. A short settle delay before returning avoids it; the answer itself is unchanged.
  await new Promise(resolve => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  const deadline = Date.now() + BUDGET_MS;
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty company name' };

    const want = normalise(kw);
    const matches = new Map();   // uen -> row
    let matchUrl = '';
    let failure = null;          // first query that could not be read
    let truncated = false;       // a query had more rows than we could page through

    for (const query of searchBases(kw)) {
      const s = await searchAll(query, deadline);
      for (const row of s.rows) {
        if (normalise(row.name) === want && !matches.has(row.uen)) {
          matches.set(row.uen, row);
          matchUrl = matchUrl || s.url;
        }
      }
      if (s.fail && !failure) failure = { reason: s.fail, excerpt: s.excerpt, url: s.url };
      if (s.truncated) truncated = true;
    }

    if (matches.size) {
      const records = [];
      for (const row of matches.values()) records.push(await toRecord(row, deadline));
      const names = records.map(r => `${r.name} (${r.uen})`).join('; ');
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchUrl,
        excerpt: `${records.length} listing(s) with the same normalised name: ${names}`.slice(0, 500),
      };
    }

    if (failure) {
      return { status: 'couldnt_check', reason: failure.reason, records: [], source_url: failure.url || API, excerpt: failure.excerpt };
    }
    if (truncated) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: `${API}?name=${encodeURIComponent(searchBases(kw)[0])}`,
        excerpt: 'too many partial-name matches to check every row; no exact match in the rows read' };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${API}?name=${encodeURIComponent(searchBases(kw)[0])}&limit=${PAGE}&page=0`,
      excerpt: `0 companies match "${kw}" on MyCareersFuture`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: API,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
