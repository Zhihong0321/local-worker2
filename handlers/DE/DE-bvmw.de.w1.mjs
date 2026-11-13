export const meta = { task: 'DE-bvmw.de', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'industry', 'member_page', 'entry_type'],
  canary: { found: 'PREALIZE GmbH', not_found: 'Zwiebelgarten Nordlichter Verwaltungsgesellschaft GmbH' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = 'https://www.bvmw.de';
const SEARCH_PAGE = `${SITE}/de/suche`;
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'ug', 'se', 'ohg', 'gbr', 'mbh', 'co', 'ev', 'ltd', 'limited', 'inc', 'llc', 'kgaa', 'eg']);

function fold(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Comparison key: case, umlauts, punctuation and legal form removed. */
function coreName(str) {
  let s = (str || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/e\.\s*v\./g, ' ev ');
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
    .filter((t) => t && !LEGAL.has(t)).join(' ');
}

/** Text sent to the site's own search: punctuation and legal form dropped, umlauts kept. */
function searchText(str) {
  const words = (str || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
    .filter((w) => w && !LEGAL.has(fold(w)));
  return words.join(' ') || (str || '').trim();
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Read the public search key the site's own search box uses, from its search page. */
async function getSearchConfig() {
  const res = await fetch(SEARCH_PAGE, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { error: fail('couldnt_check', 'blocked', SEARCH_PAGE, `HTTP ${res.status}`) };
  if (!res.ok) return { error: fail('couldnt_check', 'http_error', SEARCH_PAGE, `HTTP ${res.status}`) };
  const html = (await res.text()).replace(/&quot;/g, '"');
  const appId = html.match(/"algoliaAppId"\s*:\s*"([A-Za-z0-9]+)"/)?.[1];
  const apiKey = html.match(/"algoliaApiKey"\s*:\s*"([A-Za-z0-9]+)"/)?.[1];
  const index = html.match(/"algoliaIndexName"\s*:\s*"([^"]+)"/)?.[1];
  if (!appId || !apiKey || !index) {
    const blocked = /captcha|cf-chl|challenge-platform/i.test(html);
    return { error: fail('couldnt_check', blocked ? 'blocked' : 'layout_changed', SEARCH_PAGE, html.slice(0, 300)) };
  }
  return { appId, apiKey, index };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = (keyword || '').trim();
    if (!name) return fail('couldnt_check', 'other', SEARCH_PAGE, 'empty company name');

    const cfg = await getSearchConfig();
    if (cfg.error) return cfg.error;

    // The site's own search index (Algolia). Members are the entries with type_precise "Mitglieder".
    const url = `https://${cfg.appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.index)}/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': cfg.appId,
        'X-Algolia-API-Key': cfg.apiKey,
        'Origin': SITE,
        'Referer': SEARCH_PAGE,
      },
      body: JSON.stringify({ query: searchText(name), hitsPerPage: 100 }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return fail('couldnt_check', 'blocked', SEARCH_PAGE, `search HTTP ${res.status}`);
    }
    if (!res.ok) return fail('couldnt_check', 'http_error', SEARCH_PAGE, `search HTTP ${res.status}`);

    const data = await res.json();
    if (!data || !Array.isArray(data.hits)) {
      return fail('couldnt_check', 'layout_changed', SEARCH_PAGE, JSON.stringify(data).slice(0, 300));
    }

    const want = coreName(name);
    if (!want) return fail('couldnt_check', 'other', SEARCH_PAGE, 'name has no letters or digits to match');

    const members = data.hits.filter((h) => h && h.type_precise === 'Mitglieder' && typeof h.url === 'string' && h.url.includes('/mitglieder/'));
    const matches = members.filter((h) => coreName(h.title) === want);

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE,
        excerpt: `no BVMW member named "${name}" (${data.hits.length} search hits, ${members.length} member entries, none with this name)`,
      };
    }

    const records = matches.map((h) => ({
      name: h.title,
      industry: h.industry || '',
      member_page: h.url,
      entry_type: h.entryType || '',
    }));
    return {
      status: 'found', reason: '', records,
      source_url: matches[0].url,
      excerpt: `${matches[0].title} - ${matches[0].industry || 'BVMW member'}`.slice(0, 300),
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return fail('couldnt_check', reason, SEARCH_PAGE, String(err?.message || err));
  }
}
