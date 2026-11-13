export const meta = {
  task: 'NL-kansspelautoriteit.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'date', 'kind', 'snippet'],
  canary: { found: 'Holland Casino N.V.', not_found: 'Gokbedrijf Onbekend B.V.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://kansspelautoriteit.nl';

// Legal-form tokens dropped before comparing names (kept deliberately short: a name prefix such as "Stichting" stays).
const LEGAL = new Set(['nv', 'bv', 'vof', 'cv', 'bvba', 'sa', 'sarl', 'gmbh', 'ag', 'ltd', 'limited', 'llc', 'inc', 'plc', 'corp', 'ltda']);

function normalize(str) {
  const tokens = (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,'’&\-]/g, '')      // "N.V." -> "nv", "Holland-Casino" -> "hollandcasino"
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !LEGAL.has(t));
  return tokens.join('');
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Parse the result items of kansspelautoriteit.nl/zoeken. */
function parseItems(html) {
  const items = [];
  const blocks = html.split('<li class="search-results__li">').slice(1);
  for (const block of blocks) {
    const title = block.match(/<h3 class="search-result__title"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/);
    if (!title) continue;
    const date = block.match(/<time datetime="([^"]+)"/);
    const kind = block.match(/<article class="node node--([a-z_-]+)/);
    const snippet = block.match(/<div class="field field--search-api-excerpt">\s*<p>([\s\S]*?)<\/p>/);
    items.push({
      name: cleanText(title[2]),
      url: new URL(decodeEntities(title[1]), BASE).href,
      date: date ? date[1] : '',
      kind: kind ? kind[1].replace(/^node--/, '').split('--')[0] : '',
      snippet: snippet ? cleanText(snippet[1].replace(/<\/?b>/gi, '')).slice(0, 300) : '',   // <b> highlights sit inside words
    });
  }
  return items;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  const searchUrl = `${BASE}/zoeken?${new URLSearchParams({ searchtext: kw }).toString()}`;
  if (!kwNorm) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
  }
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    const items = parseItems(html);
    const noResults = /Er zijn geen resultaten gevonden/.test(html);
    const normalPage = items.length > 0 || noResults || /search-results__/.test(html);

    if (!normalPage) {
      if (/captcha|cf-challenge|Attention Required|Access denied/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const matches = items.filter((it) => normalize(it.name) === kwNorm);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: noResults ? 'Er zijn geen resultaten gevonden' : `${items.length} result(s) on the first page, none named "${kw}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: searchUrl,
      excerpt: `${matches.length} result(s) named "${matches[0].name}": ${matches[0].snippet}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
