export const meta = {
  task: 'ID-ralali.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'alias', 'url', 'location', 'description'],
  canary: { found: 'PT. Prima Teknik Mandiri', not_found: 'PT Bunga Matahari Angkasa Dirgantara' },
};

// Ralali's search box is a JavaScript widget that calls a token-protected API, so this handler does not use it.
// Instead it reads the public seller sitemap (every seller page is /v/<alias>), picks the seller pages whose alias
// matches the company name, and confirms each one by reading the company name printed on the seller page itself.

const BASE = 'https://www.ralali.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pt', 'cv', 'ud', 'pd', 'fa', 'firma', 'tbk', 'persero', 'perseroan', 'terbatas', 'koperasi']);
const DEADLINE_MS = 45000;
const MAX_CANDIDATES = 5;

function words(s) {
  return (s || '').toLowerCase().replace(/&amp;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** "PT. Prima Teknik Mandiri" -> "primateknikmandiri" (case, punctuation and legal form removed). */
function normName(s) {
  return words(s).filter((w) => !LEGAL_FORMS.has(w)).join('');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the two strings differ by at most `max` single-letter changes (Levenshtein distance). */
function withinEdits(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] <= max;
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt };
}

function httpFail(res, url) {
  const reason = res.status === 403 || res.status === 429 ? 'blocked' : 'http_error';
  return fail('couldnt_check', reason, url, `HTTP ${res.status}`);
}

function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const indexUrl = `${BASE}/sitemap-vendor.xml`;
  try {
    const key = normName(keyword);
    const raw = String(keyword || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key) return fail('couldnt_check', 'other', indexUrl, 'empty company name');

    // Step 1: read the seller sitemap index, then every seller sitemap, and collect the /v/<alias> entries.
    const index = await get(indexUrl);
    if (!index.ok) return httpFail(index, indexUrl);
    const indexXml = await index.text();
    const parts = [...indexXml.matchAll(/<loc>\s*([^<\s]*sitemap-vendor-\d+\.xml)\s*<\/loc>/g)].map((m) => m[1]);
    if (parts.length === 0) return fail('couldnt_check', 'layout_changed', indexUrl, indexXml.slice(0, 300));

    const aliases = new Set();
    for (const part of parts) {
      if (Date.now() - started > DEADLINE_MS) return fail('couldnt_check', 'timeout', part, 'seller sitemaps not read within 45 s');
      const res = await get(part);
      if (!res.ok) return httpFail(res, part);
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>\s*https?:\/\/[^<\s]*\/v\/([^<\s/]+)\s*<\/loc>/g)) {
        let alias = m[1];
        try { alias = decodeURIComponent(alias); } catch { /* keep the raw text */ }
        aliases.add(alias);
      }
    }
    if (aliases.size === 0) return fail('couldnt_check', 'layout_changed', indexUrl, 'no /v/ entries in the seller sitemaps');

    // Step 2: candidate aliases, best first: the same as the name; then a shorter alias the name starts with
    // (Ralali often shortens the alias, e.g. /v/tridinamika for "PT Tridinamika Jaya Instrument"); then a spelling
    // within 2 letters (e.g. /v/morrisparfume for "Morris Parfum"). Each candidate is still checked on its page.
    const ranked = [];
    for (const a of aliases) {
      const la = a.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!la) continue;
      if (la === key || la === raw) ranked.push([0, a]);
      else if (la.length >= 4 && (key.startsWith(la) || raw.startsWith(la))) ranked.push([1, a]);
      else if (la.length >= 6 && key.length >= 6 && withinEdits(la, key, 2)) ranked.push([2, a]);
    }
    ranked.sort((x, y) => x[0] - y[0] || y[1].length - x[1].length);
    const candidates = ranked.map((r) => r[1]);

    // Step 3: open each candidate seller page and confirm the company name printed on it matches the keyword.
    for (const alias of candidates.slice(0, MAX_CANDIDATES)) {
      if (Date.now() - started > DEADLINE_MS) return fail('couldnt_check', 'timeout', indexUrl, 'seller pages not checked within 45 s');
      const url = `${BASE}/v/${encodeURIComponent(alias)}`;
      const res = await get(url);
      if (res.status === 403 || res.status === 429) return httpFail(res, url);
      if (!res.ok) continue;
      const html = await res.text();
      const h1 = html.match(/<h1[^>]*class="vendor-no-mt[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
      if (!h1) {
        const landed = new URL(res.url).pathname;
        if (landed === '/' || landed === '') continue; // alias redirected to the home page: not a seller
        return fail('couldnt_check', 'layout_changed', url, html.slice(0, 300));
      }
      const vendorName = cleanText(h1[1]);
      if (normName(vendorName) !== key) continue;

      const og = html.match(/<meta property="og:title"\s+content="([^"]*)"/i);
      const ogDesc = html.match(/<meta property="og:description"\s+content="([^"]*)"/i);
      const location = og ? (og[1].split('|')[1] || '').replace(/\s+/g, ' ').trim() : '';
      const description = ogDesc ? cleanText(ogDesc[1]).slice(0, 300) : '';
      return {
        status: 'found',
        reason: '',
        records: [{ name: vendorName, alias, url, location, description }],
        source_url: url,
        excerpt: location ? `${vendorName} | ${location}` : vendorName,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: indexUrl,
      excerpt: candidates.length === 0
        ? `no seller alias in ${aliases.size} sitemap entries matches "${keyword}"`
        : `checked ${Math.min(candidates.length, MAX_CANDIDATES)} seller page(s) for "${keyword}"; none shows this company name`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail('couldnt_check', reason, indexUrl, String(err?.message || err).slice(0, 300));
  }
}
