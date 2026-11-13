export const meta = {
  task: 'IE-cif.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'website', 'listing_id'],
  canary: { found: '3D Civil Ltd', not_found: 'Cuideachta Neamhliostaithe Teoranta' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://cif.ie/members-directory/';
// Trailing legal-form words that are ignored when comparing names.
const LEGAL_TAIL = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'llp', 'unlimited', 'company', 'designated', 'activity']);

function safeChar(cp, fallback) {
  try { return String.fromCodePoint(cp); } catch { return fallback; }
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, n) => safeChar(parseInt(n, 10), m))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a name on "t/a" / "trading as" and give each part a comparison key. */
function nameKeys(text) {
  return decodeEntities(text)
    .split(/\s+t\/a\s+|\s+trading as\s+/i)
    .map(part => {
      const tokens = part
        .normalize('NFD').replace(/\p{M}+/gu, '')
        .replace(/[‘’ʼ`´']/g, '')   // apostrophes: O'Connell = OConnell
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
      while (tokens.length && LEGAL_TAIL.has(tokens[tokens.length - 1])) tokens.pop();
      return tokens.join(' ');
    })
    .filter(Boolean);
}

/** The search text the site understands: the first trading name, legal form removed. */
function searchText(keyword) {
  const first = decodeEntities(String(keyword)).split(/\s+t\/a\s+|\s+trading as\s+/i)[0];
  const words = first
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}&' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length && LEGAL_TAIL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

/** Fallback search: the longest word-piece of the name (used when the full name finds nothing). */
function fallbackText(text) {
  const pieces = text.split(/[^\p{L}\p{N}']+|\band\b/iu).map(p => p.replace(/'/g, '')).filter(p => p.length >= 3);
  pieces.sort((a, b) => b.length - a.length);
  return pieces[0] || '';
}

function searchUrl(term) {
  return `${SEARCH}?dosrch=1&q=&wpbdp_view=search&listingfields%5B1%5D=${encodeURIComponent(term)}`;
}

function parseListings(html) {
  const starts = [...html.matchAll(/<div[^>]*\bid="wpbdp-listing-(\d+)"/g)];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    let to = i + 1 < starts.length ? starts[i + 1].index : html.length;
    for (const stop of ['wpbdp-pagination', '<footer', '</main>']) {
      const k = html.indexOf(stop, from + 20);
      if (k !== -1 && k < to) to = k;
    }
    const block = html.slice(from, to);
    const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h3) continue;
    const name = stripTags(h3[1]);
    const group = block.match(/<div class="group-title[\s\S]*?<\/div>/i)?.[0] || '';
    const place = stripTags(group.replace(/<h3[\s\S]*?<\/h3>/i, '')).split(/\s+-\s+/).filter(Boolean).join(', ');
    const link = [...block.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
      .map(m => decodeEntities(m[1]))
      .find(u => !/\/\/([^/]*\.)?cif\.ie\//i.test(u));
    out.push({ listing_id: starts[i][1], name, address: place, website: link || '' });
  }
  return out;
}

/** One GET of the directory search. Returns { html } or { fail } with a ready couldnt_check answer. */
async function search(term) {
  const url = searchUrl(term);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IE,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  // Real bot-check pages only. The passive Cloudflare beacon script (challenge-platform) is on every page and is not a block.
  const blocked = /<title>\s*(Just a moment|Attention Required)/i.test(html) || (res.status === 503 && /cf-chl|challenge-form/i.test(html));
  if (res.status === 403 || res.status === 429 || blocked) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}${blocked ? ' bot check' : ''}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` } };
  }
  if (!/wpbdp-search-page|What would you like to search for|wpbdp-listings-list|No listings found/i.test(html)) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: stripTags(html).slice(0, 300) } };
  }
  return { html, url };
}

async function run(keyword) {
  const wanted = nameKeys(String(keyword));
  try {
    const full = searchText(keyword);
    if (!full || wanted.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH, excerpt: 'empty company name' };
    }

    // Attempt 1: the name as written (legal form removed). Attempt 2 only if attempt 1 has no exact match.
    const terms = [full];
    const fb = fallbackText(full);
    if (fb && fb.toLowerCase() !== full.toLowerCase()) terms.push(fb);

    let lastUrl = searchUrl(full);
    let lastExcerpt = '';
    for (const term of terms) {
      const got = await search(term);
      if (got.fail) return got.fail;
      lastUrl = got.url;

      const listings = parseListings(got.html);
      if (listings.length === 0 && !/No listings found/i.test(got.html)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: got.url, excerpt: stripTags(got.html).slice(0, 300) };
      }

      const matches = listings.filter(l => nameKeys(l.name).some(k => wanted.includes(k)));
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map(m => ({ name: m.name, address: m.address, website: m.website, listing_id: m.listing_id })),
          source_url: got.url,
          excerpt: matches.map(m => [m.name, m.address, m.website].filter(Boolean).join(' | ')).join(' ; ').slice(0, 300),
        };
      }
      lastExcerpt = `${listings.length} listing(s) on the site for "${term}", none with this name`;
    }

    return { status: 'not_found', reason: '', records: [], source_url: lastUrl, excerpt: lastExcerpt || `No listings found for "${full}"` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl(searchText(String(keyword)) || String(keyword)),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // On Windows, Node 24 aborts with an assertion when the process exits while a fetch's AbortSignal.timeout timer is
  // still pending, and the runner exits right after the answer. A short pause lets those handles close first.
  await new Promise(resolve => setTimeout(resolve, 500));
  return answer;
}
