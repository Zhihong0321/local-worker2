export const meta = {
  task: 'AR-paginasamarillas.com.ar',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'site_name', 'verticals', 'is_brand'],
  canary: { found: 'Buenos Aires Vending', not_found: 'Zxqwv Inexistente Sociedad Anonima' },
};

const BASE = 'https://www.paginasamarillas.com.ar/api/solr/suggestions/search-words';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Argentine legal-form words that are dropped before comparing names ("S.A.", "S.R.L.", "Sociedad Anonima" ...).
const LEGAL_FORMS = new Set(['sa', 'srl', 'sas', 'ltda', 'sca', 'scs', 'saic', 'sacif', 'sacifia', 'sociedad', 'anonima', 'responsabilidad', 'limitada']);

/** Lower-case, strip accents and punctuation (dots first, so "S.A." becomes "sa"), drop legal-form words. */
function normalizeName(str) {
  const tokens = (str || '')
    .replace(/\./g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (tokens.length && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

/**
 * The site's suggest index does not match names that still carry dots or a legal form ("Capria Hnos. S.A." finds
 * nothing, "Capria Hnos" finds it), so the search word is the name without dots and without the trailing legal form.
 */
function searchTerm(str) {
  const words = (str || '').replace(/\./g, '').split(/[\s,;]+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(normalizeName(words[words.length - 1]))) words.pop();
  return words.join(' ') || (str || '').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const url = `${BASE}?searchWord=${encodeURIComponent(searchTerm(keyword))}&isCompany=true&maxResults=20`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/captcha|challenge|cloudflare|are you a robot/i.test(text)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: text.slice(0, 200) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 200) };
    }

    if (!Array.isArray(data) || data.some((s) => !s || typeof s.suggest !== 'string')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 200) };
    }

    const want = normalizeName(keyword);
    const matches = want ? data.filter((s) => normalizeName(s.originalSuggest || s.suggest) === want
      || normalizeName(s.suggest) === want) : [];

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `0 of ${data.length} company suggestions match "${keyword}"`,
      };
    }

    const records = matches.map((s) => ({
      name: s.originalSuggest || s.suggest,
      site_name: s.suggest,
      verticals: Array.isArray(s.verticals) ? s.verticals : [],
      is_brand: Boolean(s.isBrand),
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: records.map((r) => `${r.name} [${r.verticals.join(',')}]`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
