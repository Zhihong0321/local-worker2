export const meta = { task: 'PH-techinasia.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'slug', 'profile_url', 'country', 'date_founded', 'employee_count', 'industries', 'funding_stages',
    'total_amount_raised', 'total_amount_raised_2y', 'job_posting_count', 'website'],
  canary: { found: 'Globe', not_found: 'Kompanyang Walang Rehistro Inc.' } };

// Tech in Asia's company directory is a client-side search. The site's own front end sends each search to a
// hosted search index (Algolia) using a search key that is published in the site's public JavaScript bundle.
// This handler does the same: it reads the key from the home page's bundle at run time (nothing is stored here),
// then runs one search on the "companies" index.

const SITE = 'https://www.techinasia.com/';
const INDEX = 'companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' };
const FETCH_MS = 25000;
const DEADLINE_MS = 55000; // the whole call must finish in under 60 s

// Legal-form words, dropped from both sides before names are compared (and from the search text, because the
// index needs every query word to appear in the name: "Globe Inc" finds nothing, "Globe" finds Globe).
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'pte', 'pty',
  'llc', 'llp', 'lp', 'plc', 'gmbh', 'ag', 'sa', 'srl', 'bv', 'kk', 'sdn', 'bhd', 'berhad', 'pt', 'tbk', 'opc', 'pvt', 'private']);

function tokens(str) {
  return String(str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function searchTokens(str) {
  return tokens(str).filter((t) => !LEGAL.has(t));
}

function nameKey(str) {
  return searchTokens(str).join('');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function netFail(err, url) {
  const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return fail(timedOut ? 'timeout' : 'other', url, String(err?.message || err));
}

function httpFail(res, url) {
  if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
  return fail('http_error', url, `HTTP ${res.status}`);
}

function uniq(list) {
  return [...new Set(list)];
}

function toRecord(h) {
  const website = (h.entity_sites || []).find((s) => /website/i.test(s?.site_name || ''));
  return {
    name: h.name || '',
    slug: h.entity_slug || '',
    profile_url: h.entity_slug ? `${SITE}companies/${h.entity_slug}` : '',
    country: uniq((h.entity_locations || []).map((l) => l?.country_name).filter(Boolean)),
    date_founded: h.date_founded || '',
    employee_count: h.employee_count || '',
    industries: (h.entity_industries || []).map((i) => i?.name).filter(Boolean),
    funding_stages: (h.funding_stages || []).map((s) => (typeof s === 'string' ? s : s?.name || '')).filter(Boolean),
    total_amount_raised: h.total_amount_raised ?? null,
    total_amount_raised_2y: h.total_amount_raised_2y ?? null,
    job_posting_count: h.job_posting_count ?? null,
    website: website ? website.url : '',
  };
}

async function run(keyword) {
  const name = String(keyword || '').trim();
  if (!nameKey(name)) return fail('other', SITE, 'empty company name');

  // 1. Home page: find the app bundle that carries the directory's search key.
  let home;
  try {
    home = await fetch(SITE, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(FETCH_MS) });
  } catch (err) {
    return netFail(err, SITE);
  }
  if (!home.ok) return httpFail(home, SITE);
  const homeHtml = await home.text();
  const bundleMatch = homeHtml.match(/src="((?:https?:)?\/\/static\.techinasia\.com\/assets\/[^"]*\/app\.[0-9a-f]+\.js)"/);
  if (!bundleMatch) return fail('layout_changed', SITE, 'no app bundle script on the home page');
  const bundleUrl = bundleMatch[1].startsWith('//') ? `https:${bundleMatch[1]}` : bundleMatch[1];

  // 2. App bundle: read the search application id and search-only key.
  let bundle;
  try {
    bundle = await fetch(bundleUrl, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(FETCH_MS) });
  } catch (err) {
    return netFail(err, bundleUrl);
  }
  if (!bundle.ok) return httpFail(bundle, bundleUrl);
  const js = await bundle.text();
  let appId = '';
  let apiKey = '';
  for (const m of js.matchAll(/algolia:\{([^{}]*)\}/g)) {
    const id = m[1].match(/appId:"([A-Za-z0-9]{10})"/);
    const key = m[1].match(/apiKey:"([0-9a-f]{32})"/);
    if (id && key) {
      appId = id[1];
      apiKey = key[1];
      break;
    }
  }
  if (!appId || !apiKey) return fail('layout_changed', bundleUrl, 'search key not found in the app bundle');

  // 3. One search on the companies index.
  const query = searchTokens(name).join(' ') || name;
  const searchUrl = `https://${appId}-dsn.algolia.net/1/indexes/${INDEX}/query`;
  let res;
  try {
    res = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key': apiKey,
      },
      body: JSON.stringify({ query, hitsPerPage: 50 }),
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (err) {
    return netFail(err, searchUrl);
  }
  if (!res.ok) return httpFail(res, searchUrl);

  let data;
  try {
    data = await res.json();
  } catch {
    return fail('layout_changed', searchUrl, 'search response is not JSON');
  }
  if (!data || !Array.isArray(data.hits)) {
    return fail('layout_changed', searchUrl, `search response has no hits list: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // 4. Keep only exact name matches (legal form ignored). A match counts for the Philippines when it is located
  //    there or when the directory lists no location for it; a same-name company listed only abroad is not a match.
  const want = nameKey(name);
  const exact = data.hits.filter((h) => nameKey(h.name) === want);
  const isPH = (h) => !Array.isArray(h.entity_locations) || h.entity_locations.length === 0
    || h.entity_locations.some((l) => /philippines/i.test(l?.country_name || ''));
  const matches = exact.filter(isPH);

  if (matches.length === 0) {
    const abroad = exact.map((h) => `${h.name} (${uniq((h.entity_locations || []).map((l) => l?.country_name).filter(Boolean)).join(', ') || 'no location'})`);
    const note = abroad.length ? `; same name listed outside the Philippines: ${abroad.join('; ')}` : '';
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `No "${name}" in the Tech in Asia company directory (search "${query}": ${data.hits.length} hits, ${exact.length} with the same name)${note}`,
    };
  }

  const records = matches.map(toRecord);
  const first = records[0];
  return {
    status: 'found',
    reason: '',
    records,
    source_url: searchUrl,
    excerpt: `Tech in Asia directory: "${first.name}" (${first.country.join(', ') || 'no location'}); employees ${first.employee_count || 'n/a'}; total raised ${first.total_amount_raised ?? 'n/a'}`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail('timeout', SITE, 'the lookup did not finish in 55 s')), DEADLINE_MS);
  });
  try {
    return await Promise.race([run(keyword), deadline]);
  } catch (err) {
    return fail('other', SITE, String(err?.message || err));
  } finally {
    clearTimeout(timer);
  }
}
