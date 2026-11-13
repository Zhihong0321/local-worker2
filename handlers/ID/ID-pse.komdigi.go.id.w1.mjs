export const meta = {
  task: 'ID-pse.komdigi.go.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'system_name', 'domain', 'registration_number', 'status', 'registered_date', 'is_domestic'],
  canary: { found: 'GOTO GOJEK TOKOPEDIA', not_found: 'Tidak Terdaftar Sejahtera Makmur Lestari' },
};

// The search box on https://pse.komdigi.go.id/pse posts to this JSON API (found in the page's JavaScript).
const API_URL = 'https://pse.komdigi.go.id/api/v1/tdpse/tdpse-list';
const SEARCH_PAGE = 'https://pse.komdigi.go.id/pse';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;          // at most 500 results read per lookup
const START_LIMIT_MS = 30000; // do not start a new request after 30 s (each request can take up to 25 s)

// Indonesian legal-form words. Removed from both sides before comparing names.
const LEGAL = new Set(['PT', 'PERSERO', 'TBK', 'CV', 'UD', 'YAYASAN', 'PTE', 'LTD', 'LIMITED', 'SDN', 'BHD', 'LLC', 'INC']);

const upper = (s) => String(s || '').toUpperCase();
const bare = (tok) => upper(tok).replace(/[^\p{L}\p{N}]/gu, '');
const isLegal = (tok) => LEGAL.has(bare(tok));

/** Compare key: upper case, punctuation dropped, legal-form words dropped. */
function normalize(name) {
  return upper(name)
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');
}

/** Search text sent to the site: the typed name without legal-form words at its start or end. */
function searchText(name) {
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (toks.length && isLegal(toks[0])) toks.shift();
  while (toks.length && isLegal(toks[toks.length - 1])) toks.pop();
  return toks.join(' ').slice(0, 100).trim();
}

function couldnt(reason, excerpt, sourceUrl = API_URL) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** One POST to the search API. Returns { json } or { fail: reason, excerpt }. Never throws. */
async function post(body) {
  let res;
  let text;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Referer': SEARCH_PAGE,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e) };
  }
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (res.status === 422) return { fail: 'other', excerpt: `HTTP 422 ${text.slice(0, 200)}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const challenge = /captcha|cloudflare|just a moment|challenge/i.test(text);
    return { fail: challenge ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 200) };
  }
  return { json };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  try {
    const target = normalize(keyword);
    if (!target) return couldnt('other', 'no company words in the input');

    const query = searchText(keyword);
    if (query.length < 3) return couldnt('other', `search text too short for the site (minimum 3 characters): "${query}"`);

    const matches = [];
    let total = null;
    let read = 0;
    let truncated = false;

    for (let page = 0; ; page++) {
      if (Date.now() - t0 > START_LIMIT_MS) return couldnt('timeout', 'stopped before the 60 s limit');

      const r = await post({
        keyword: query,
        length: PAGE_SIZE,
        sort_by: [{ column: 'tanggal_terdaftar', asc_desc: 'DESC' }],
        start: page * PAGE_SIZE,
      });
      if (r.fail) return couldnt(r.fail, r.excerpt);

      const j = r.json;
      if (j.status !== 'success' || !j.data || !Array.isArray(j.data.data) || typeof j.data.total_rows !== 'number') {
        const reason = j.status === 'success' ? 'layout_changed' : 'other';
        return couldnt(reason, `status=${j.status} message=${j.message} error=${JSON.stringify(j.error)}`);
      }

      total = j.data.total_rows;
      const rows = j.data.data;
      read += rows.length;
      for (const row of rows) {
        if (normalize(row.pse_name) === target) matches.push(row);
      }

      if (rows.length === 0 || read >= total) break;
      if (page + 1 >= MAX_PAGES) { truncated = true; break; }
    }

    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map((row) => ({
          name: row.pse_name || '',
          system_name: row.nama_se || '',
          domain: row.domain || '',
          registration_number: row.nomor_tdpse || '',
          status: row.status || '',
          registered_date: row.tanggal_terdaftar || '',
          is_domestic: row.is_domestik === true ? 'Domestik' : row.is_domestik === false ? 'Asing' : '',
        })),
        source_url: API_URL,
        excerpt: `${matches.length} record(s) named "${first.pse_name}" in ${total} result(s) for "${query}": ${first.nomor_tdpse}, ${first.status}, ${first.tanggal_terdaftar}`,
      };
    }

    if (truncated) {
      return couldnt('other', `no exact name in the first ${read} of ${total} results for "${query}"`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: API_URL,
      excerpt: total === 0
        ? `0 results for "${query}"`
        : `${total} similar result(s) for "${query}", none named "${target}"`,
    };
  } catch (err) {
    return couldnt('other', String(err?.message || err));
  }
}
