export const meta = {
  task: 'NL-rva.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'kvk', 'street', 'postal_city', 'country'],
  canary: { found: 'DEKRA Certification B.V.', not_found: 'Stichting Zwarte Kwarts Onbekend' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.7',
};
const SEARCH_BASE = 'https://www.rva.nl/alle-geaccrediteerden/?s=';
// No new fetch starts after this many ms, so the last one (max 25 s) ends inside the 60 s limit.
const LAST_START_MS = 30000;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&#(\d+);/g, (m, d) => (parseInt(d, 10) <= 0x10ffff ? String.fromCodePoint(parseInt(d, 10)) : m))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const key = n.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare company names: case, accents, dots, punctuation and Dutch legal form are ignored. */
function normalize(name) {
  return decodeEntities(String(name || ''))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(b\s+v|n\s+v|bv|nv|vof|cv|stichting)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The site search misses some spellings (e.g. "BV" without dots), so also try the name without its legal form. */
function queriesFor(keyword) {
  const full = String(keyword || '').trim().replace(/\s+/g, ' ');
  const stripped = full
    .replace(/^stichting\s+/i, '')
    .replace(/[\s,]+(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?)$/i, '')
    .trim();
  return [...new Set([full, stripped].filter(Boolean))];
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Best effort: the organisation page adds KvK number and address. Failure here does not lose the match. */
async function fetchOrgDetail(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const html = await res.text();
    const pick = (cls) => {
      const m = html.match(new RegExp(`<p class="${cls}">([\\s\\S]*?)<\\/p>`, 'i'));
      return m ? cleanText(m[1]) : '';
    };
    const kvkMatch = html.match(/KVK:\s*(\d+)/i);
    return {
      name: pick('org-data__name'),
      street: pick('org-data__street'),
      postal_city: pick('org-data__adress'),
      country: pick('org-data__country'),
      kvk: kvkMatch ? kvkMatch[1] : '',
    };
  } catch {
    return null;
  }
}

/** One search request. Returns { url, hits } or { url, fail }. */
async function searchOnce(query) {
  const url = SEARCH_BASE + encodeURIComponent(query);
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, fail: { reason: timedOut ? 'timeout' : 'other', excerpt: String((err && err.message) || err) } };
  }
  if (res.status === 403 || res.status === 429) return { url, fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { url, fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };

  const html = await res.text();
  const hasResults = /search-results__total|search-results__header/.test(html);
  const hasEmpty = /Geen resultaten gevonden/.test(html);
  if (!hasResults && !hasEmpty) {
    if (/captcha|challenge-platform|cf-chl|access denied|verify you are human/i.test(html)) {
      return { url, fail: { reason: 'blocked', excerpt: html.slice(0, 300) } };
    }
    return { url, fail: { reason: 'layout_changed', excerpt: html.slice(0, 300) } };
  }

  // Each hit: <a href="URL"><h3 class="search-results__header"><span class="search-results__name">NAME</span>
  // Organisation hits link to /organisaties/<slug>/; accreditation hits (C001, M011, ...) link to /alle-geaccrediteerden/<id>/.
  const hits = [];
  const hitRe = /<a[^>]*href="([^"]+)"[^>]*>\s*<h3[^>]*search-results__header[^>]*>\s*<span[^>]*search-results__name[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = hitRe.exec(html)) !== null) {
    if (m[1].includes('/organisaties/')) {
      hits.push({ url: new URL(m[1], 'https://www.rva.nl').href, name: cleanText(m[2]) });
    }
  }
  return { url, hits };
}

async function run(keyword) {
  const started = Date.now();
  const queries = queriesFor(keyword);
  const firstUrl = SEARCH_BASE + encodeURIComponent(String(keyword || '').trim());
  if (!normalize(keyword)) return fail('other', firstUrl, 'empty company name');

  const want = normalize(keyword);
  const nearest = [];
  const tried = [];
  let lastUrl = firstUrl;

  for (let i = 0; i < queries.length; i++) {
    if (i > 0 && Date.now() - started >= LAST_START_MS) {
      return fail('timeout', lastUrl, `no time left for search "${queries[i]}"`);
    }
    const page = await searchOnce(queries[i]);
    lastUrl = page.url;
    if (page.fail) return fail(page.fail.reason, page.url, page.fail.excerpt);
    tried.push(queries[i]);

    const matched = [];
    const seen = new Set();
    for (const hit of page.hits) {
      if (normalize(hit.name) === want && !seen.has(hit.url)) {
        seen.add(hit.url);
        matched.push(hit);
      }
      nearest.push(hit.name);
    }
    if (matched.length === 0) continue;

    const records = [];
    for (const hit of matched) {
      const detail = Date.now() - started < LAST_START_MS ? await fetchOrgDetail(hit.url) : null;
      records.push({
        name: (detail && detail.name) || hit.name,
        url: hit.url,
        kvk: (detail && detail.kvk) || '',
        street: (detail && detail.street) || '',
        postal_city: (detail && detail.postal_city) || '',
        country: (detail && detail.country) || '',
      });
    }
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: matched[0].url,
      excerpt: `${first.name} | KVK ${first.kvk || 'n/a'} | ${first.street} ${first.postal_city}`.replace(/\s+/g, ' ').trim(),
    };
  }

  const names = [...new Set(nearest)].slice(0, 5).join('; ');
  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl,
    excerpt: `Searched "${tried.join('" and "')}": no organisation with this name.${names ? ` Nearest: ${names}` : ''}`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let out;
  try {
    out = await run(keyword);
  } catch (err) {
    const name = err && err.name;
    out = fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other',
      SEARCH_BASE + encodeURIComponent(String(keyword || '').trim()), String((err && err.message) || err));
  }
  // Let the sockets close before the worker process exits (Windows Node 24 asserts on exit otherwise).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}
