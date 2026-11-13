export const meta = {
  task: 'DE-boersennews.de',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'isin', 'wkn', 'sector', 'listing_type', 'market_url'],
  canary: { found: 'HORNBACH Holding', not_found: 'Nichtboerse Musterfirma GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.boersennews.de';

// Legal-form words that are dropped before comparing names.
const LEGAL = new Set(['ag', 'se', 'gmbh', 'kgaa', 'kg', 'co', 'ug', 'sa', 'nv', 'bv', 'plc', 'ltd', 'limited', 'inc', 'corp', 'corporation', 'llc', 'spa', 'ab', 'oyj', 'ohg', 'gbr', 'ev', 'kgaa']);

function words(s) {
  return (s || '').replace(/&amp;/gi, ' ').replace(/[&.,()\/-]/g, ' ').split(/\s+/).filter(Boolean);
}

function clean(w) {
  return (w || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Normalised key of a name: lower case, no marks, no punctuation, no legal form, no spaces.
function key(s) {
  return words(s).map(clean).filter((w) => w && !LEGAL.has(w)).join('');
}

// The search query: the name as typed, minus its legal form words.
function query(s) {
  return words(s).filter((w) => { const c = clean(w); return c && !LEGAL.has(c); }).join(' ');
}

function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function getText(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/html;q=0.9, */*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // let the last socket close before the worker process exits (avoids a libuv abort on Windows Node)
  await new Promise((done) => setTimeout(done, 500));
  return answer;
}

async function lookupOnce(keyword) {
  let searchUrl = '';
  try {
    const q = query(keyword);
    const want = key(keyword);
    if (!q || !want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'name has no words left after removing the legal form' };
    }
    searchUrl = `${BASE}/search/gcs/${encodeURIComponent(q)}/`;

    const res = await getText(searchUrl);
    const body = await res.text();
    if (res.status === 403 || res.status === 429 || /captcha|cf-chl|access denied/i.test(body.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    if (!json || typeof json.html !== 'string' || typeof json.hasResults !== 'boolean') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: body.slice(0, 300) };
    }

    if (json.hasResults === false) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 results for "${q}"` };
    }

    // Result rows: <a class="stretched-link" href="...">title</a>. Only listed stocks (/markt/aktien/detail/) count as the company.
    const links = [...json.html.matchAll(/<a class="stretched-link" href="([^"]+)">([\s\S]*?)<\/a>/g)]
      .map((m) => ({ href: new URL(m[1].replace(/&amp;/g, '&'), BASE).href, title: decode(m[2]) }));
    const stocks = links.filter((l) => new URL(l.href).pathname.startsWith('/markt/aktien/detail/'));
    const matches = [];
    const seen = new Set();
    for (const l of stocks) {
      if (key(l.title) === want && !seen.has(l.href)) {
        seen.add(l.href);
        matches.push(l);
      }
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${links.length} results for "${q}", none is a listed stock named like it`,
      };
    }

    const records = [];
    for (const m of matches.slice(0, 3)) {
      const isin = (new URL(m.href).pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
      let wkn = '';
      let sector = '';
      try {
        const dres = await getText(m.href);
        if (dres.ok) {
          const page = await dres.text();
          wkn = (page.match(/WKN:<\/small>\s*([A-Z0-9]{5,6})/) || [])[1] || '';
          sector = decode((page.match(/Handel<\/a>\s*:<\/small>\s*<a[^>]*>([^<]+)<\/a>/) || [])[1] || '');
        }
      } catch {
        // detail page missing: keep the record from the search row
      }
      records.push({ name: m.title, isin, wkn, sector, listing_type: 'Aktie', market_url: m.href });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: matches.map((m) => m.title).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
