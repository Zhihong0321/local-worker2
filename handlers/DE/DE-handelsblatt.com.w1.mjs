export const meta = {
  task: 'DE-handelsblatt.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'isin', 'wkn', 'classification', 'currency', 'ticker'],
  canary: { found: 'DEUTSCHE BANK AG NA O.N.', not_found: 'Zzqxwvk Handelsgesellschaft GmbH' },
};

// Handelsblatt's market-data search (the API behind the quote pages) lists listed securities: shares and bonds.
// It is not a register of all companies, so a company with no listed shares or bonds is not_found here.
const API = 'https://market.www.handelsblatt.com/api/search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms and share-class tokens that only count at the end of a name ("... AG NA O.N.").
const TRAILING_NOISE = new Set([
  'ag', 'se', 'gmbh', 'kgaa', 'kg', 'ohg', 'co', 'ug', 'ltd', 'limited', 'plc', 'inc', 'corp', 'sa', 'nv', 'bv',
  'spa', 'srl', 'ab', 'oyj', 'llc', 'lp', 'mbh', 'na', 'on', 'o', 'n', 'st', 'vz', 'vzo',
]);

/** Lower case, German umlauts spelled out, accents removed, punctuation dropped. */
function tokens(str) {
  return (str || '')
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** The name without trailing legal form and share-class tokens, as a list of tokens. */
function core(str) {
  const t = tokens(str);
  while (t.length && TRAILING_NOISE.has(t[t.length - 1])) t.pop();
  return t;
}

/** The keyword with trailing legal form / share-class words removed, for the site's search box. */
function searchTermOf(keyword) {
  const words = keyword.trim().split(/\s+/);
  while (words.length && TRAILING_NOISE.has(tokens(words[words.length - 1]).join(''))) words.pop();
  return words.join(' ') || keyword.trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const term = searchTermOf(String(keyword || ''));
  const searchUrl = `${API}?searchTerm=${encodeURIComponent(term)}&limit=50`;
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'user-agent': UA,
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'de-DE,de;q=0.9,en;q=0.5',
        'referer': 'https://www.handelsblatt.com/',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      rows = null;
    }
    if (!contentType.includes('json') || !Array.isArray(rows) ||
        rows.some((r) => !r || typeof r !== 'object' || typeof r.name !== 'string')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    const want = core(keyword).join('');
    const matches = want ? rows.filter((r) => core(r.name).join('') === want) : [];

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `search returned ${rows.length} listing(s); none has the name "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((r) => ({
        name: r.name,
        isin: r.isin ?? null,
        wkn: r.wkn ?? null,
        classification: r.classification ?? null,
        currency: r.currency ?? null,
        ticker: r.ticker ?? null,
      })),
      source_url: searchUrl,
      excerpt: matches.map((r) => `${r.name} (${r.classification}, ISIN ${r.isin})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
