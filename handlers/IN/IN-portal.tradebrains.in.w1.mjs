export const meta = {
  task: 'IN-portal.tradebrains.in',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'symbol', 'co_code', 'fincode', 'default_view'],
  canary: { found: 'Hindustan Unilever Ltd', not_found: 'भारत कल्पित कंपनी लिमिटेड' },
};

const API = 'https://portal.tradebrains.in/api/company/search/portal/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words that are dropped from the END of a name. The site's search does not match
// "Ltd." or "Limited" in the query, so the search uses the core name only.
const LEGAL_FORMS = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'plc', 'inc']);

/** Lowercase; letters, marks and digits only (keeps Devanagari and other scripts); single spaces. */
function clean(str) {
  return String(str || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** Normalised core name: cleaned, with trailing legal-form words removed. */
function coreName(str) {
  const words = clean(str).split(' ').filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = API;
  try {
    const core = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'no company name to search' };
    }
    searchUrl = `${API}?search=${encodeURIComponent(core)}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    if (!data || !Array.isArray(data.stock)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    // Match the company, not just similar words: compare core names exactly.
    const seen = new Set();
    const records = [];
    for (const s of data.stock) {
      if (!s || s.co_code == null || coreName(s.company) !== core || seen.has(s.co_code)) continue;
      seen.add(s.co_code);
      records.push({
        name: s.company,
        symbol: s.symbol ?? '',
        co_code: s.co_code,
        fincode: s.FINCODE ?? null,
        default_view: s.default ?? '',
      });
    }

    if (records.length === 0) {
      const others = data.stock.slice(0, 5).map((s) => s.company).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: data.stock.length
          ? `Site search returned ${data.stock.length} result(s), none matching "${keyword}": ${others}`
          : `Site search returned 0 results for "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: JSON.stringify(records).slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
