export const meta = {
  task: 'US-sec.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ticker', 'cik', 'entity_raw'],
  canary: { found: 'Apple Inc.', not_found: 'Zqxvbrl Holdings Inc' },
};

// The same JSON endpoint the SEC company search page calls (its smartSearch.js uses this URL).
const BASE = 'https://efts.sec.gov/LATEST/search-index';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are ignored when comparing names (both sides are normalised the same way).
const LEGAL = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'lc', 'lp', 'llp',
  'plc', 'sa', 'nv', 'bv', 'ag', 'gmbh', 'the', 'sdn', 'bhd', 'berhad', 'pte', 'pvt', 'cv', 'srl', 'spa',
]);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean);
}

/** Comparison key: words without legal form, no spaces. "Apple Inc." and "APPLE INC" both give "apple". */
function nameKey(name) {
  return tokens(name).filter((t) => !LEGAL.has(t)).join('');
}

async function getHits(query) {
  const url = `${BASE}?keysTyped=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { url, res, text };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let lastUrl = BASE;
  try {
    const allTokens = tokens(keyword);
    const core = allTokens.filter((t) => !LEGAL.has(t));
    const key = core.join('');
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no usable name in the input' };
    }

    // First search the name without legal form; if that finds nothing, search the full typed name.
    const queries = [core.join(' ')];
    if (allTokens.join(' ') !== core.join(' ')) queries.push(allTokens.join(' '));

    const records = [];
    const seen = new Set();
    let matchUrl = '';
    for (const q of queries) {
      const r = await getHits(q);
      lastUrl = r.url;
      if (r.res.status === 403 || r.res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: r.url, excerpt: `HTTP ${r.res.status}: ${r.text.slice(0, 200)}` };
      }
      if (!r.res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: r.url, excerpt: `HTTP ${r.res.status}` };
      }
      let json;
      try { json = JSON.parse(r.text); } catch { json = null; }
      const hits = json?.hits?.hits;
      if (!Array.isArray(hits)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: r.url, excerpt: r.text.slice(0, 300) };
      }

      for (const h of hits) {
        const src = h?._source || {};
        const entity = String(src.entity || '');
        const tickerMatch = entity.match(/\s*\(([^()]{1,12})\)\s*$/);
        const name = entity.replace(/\s*\([^()]{1,12}\)\s*$/, '').trim();
        if (!name || nameKey(name) !== key) continue;
        const cik = String(h._id || '').replace(/\D/g, '');
        if (!cik || seen.has(cik)) continue;
        seen.add(cik);
        records.push({
          name,
          ticker: String(src.tickers || (tickerMatch ? tickerMatch[1] : '')),
          cik: cik.padStart(10, '0'),
          entity_raw: entity,
        });
      }
      if (records.length) { matchUrl = r.url; break; }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchUrl || lastUrl,
        excerpt: records.map((x) => x.entity_raw).join(' | ').slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `SEC EDGAR company index answered; no entity with the same normalised name as "${keyword}"`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
