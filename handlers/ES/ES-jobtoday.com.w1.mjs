export const meta = {
  task: 'ES-jobtoday.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'key', 'business_category', 'about', 'city', 'address', 'city_searched'],
  canary: { found: 'Trust Marketing Espana S.L.', not_found: 'Servicios Inexistentes Zqxwvk S.L.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://jobtoday.com/es/search';
// The site's search only filters by city (a blank location or "España" finds no company). Searched in parallel.
const CITIES = ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Zaragoza', 'Málaga', 'Murcia', 'Palma', 'Granada', 'Valladolid'];
// Legal-form words dropped before comparing, so "Trust Marketing Espana S.L." matches "Trust Marketing Espana".
const LEGAL = new Set(['sl', 'sa', 'slu', 'sll', 'sau', 'scp', 'slne', 'sc', 'ltd', 'sociedad', 'limitada', 'anonima', 'cooperativa', 'coop']);

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL.has(t))
    .join('');
}

/** Pull every JSON array that follows "companies": out of the page's embedded data. */
function parseCompanies(html) {
  const out = [];
  const marker = /"companies":\[/g;
  let m;
  while ((m = marker.exec(html)) !== null) {
    const start = m.index + m[0].length - 1; // position of '['
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) return null;
    try {
      const arr = JSON.parse(html.slice(start, end + 1));
      if (Array.isArray(arr)) out.push(...arr);
    } catch {
      return null;
    }
  }
  return out;
}

async function searchCity(keyword, city) {
  const url = `${BASE}?keyword=${encodeURIComponent(keyword)}&location=${encodeURIComponent(city)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { city, url, failure: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { city, url, failure: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    if (/captcha|cf-chl|Just a moment/i.test(html.slice(0, 20000))) return { city, url, failure: 'blocked', detail: 'bot check page' };
    const companies = parseCompanies(html);
    const noResults = html.includes('No encontramos ninguna oferta');
    if (companies === null) return { city, url, failure: 'layout_changed', detail: noResults ? 'company data unreadable' : 'no company data on page' };
    return { city, url, companies, noResults, failure: null };
  } catch (err) {
    const t = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { city, url, failure: t ? 'timeout' : 'other', detail: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}?keyword=${encodeURIComponent(String(keyword || ''))}&location=Madrid`;
  try {
    const want = normName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }
    const results = await Promise.all(CITIES.map((c) => searchCity(String(keyword).trim(), c)));

    const matches = new Map();
    for (const r of results) {
      if (r.failure) continue;
      for (const c of r.companies) {
        if (c && typeof c.name === 'string' && normName(c.name) === want && !matches.has(c.key)) {
          matches.set(c.key, { c, city: r.city, url: r.url });
        }
      }
    }

    if (matches.size) {
      const list = [...matches.values()];
      return {
        status: 'found',
        reason: '',
        records: list.map(({ c, city }) => ({
          name: c.name,
          key: c.key,
          business_category: c.businessCategory || '',
          about: c.about || '',
          city: c.location?.city || '',
          address: c.location?.address || '',
          city_searched: city,
        })),
        source_url: list[0].url,
        excerpt: `Company list entry: ${list[0].c.name} (${list[0].c.about || ''})`.slice(0, 500),
      };
    }

    const failed = results.filter((r) => r.failure);
    if (failed.length) {
      // The site refused or failed some searches: never a not_found.
      return {
        status: 'couldnt_check',
        reason: failed[0].failure,
        records: [],
        source_url: failed[0].url,
        excerpt: `${failed.length} of ${CITIES.length} city searches failed: ${failed.map((f) => `${f.city} ${f.failure} ${f.detail}`).join('; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `No matching company in the site's company lists for ${String(keyword).trim()} in ${CITIES.length} cities`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 500),
    };
  }
}
