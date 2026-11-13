export const meta = {
  task: 'NZ-builderscrack.co.nz',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'trade', 'location', 'rating', 'profile_url'],
  canary: { found: 'Stoic Builders Ltd', not_found: 'Kaiāwhina Hanga Tūturu Limited' },
};

// Builderscrack business-name search: GET /trades/all?search_term=<text>, 12 tradies per page.
// The site matches the text as a plain substring of the business name, so the legal form
// ("Ltd", "Limited") is removed from the search text and then compared on both sides.

const BASE = 'https://builderscrack.co.nz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'llc', 'inc', 'incorporated', 'company', 'co', 'lp', 'plc']);
const MAX_PAGES = 5;
const DEADLINE_MS = 45000;

function stripMarks(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Lower-case words, accents removed, "&" read as "and". */
function words(str) {
  return stripMarks(str).replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Comparison key: legal form and "and" removed, so "N & P Building Solutions Ltd" = "N&P Building Solutions". */
function matchKey(str) {
  const w = words(str);
  const core = w.filter((x) => !LEGAL.has(x) && x !== 'and');
  return (core.length ? core : w).join(' ');
}

/** The text sent to the site: the user's words with the legal form dropped. */
function searchTerm(keyword) {
  const parts = keyword.split(/\s+/).filter((p) => {
    const n = stripMarks(p).replace(/[^\p{L}\p{N}]/gu, '');
    return !LEGAL.has(n);
  });
  return (parts.length ? parts.join(' ') : keyword).trim();
}

function buildUrl(term, page) {
  const u = new URL('/trades/all', BASE);
  u.searchParams.set('search_term', term);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function decodeEntities(s) {
  return s
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Tradie cards on one results page. Job cards are skipped (they have no /tradies/ link). */
function parseCards(html) {
  const cards = [];
  for (const chunk of html.split('<div class="card text-start')) {
    const head = chunk.match(/card-title text-truncate mb-0 col[^"]*"\s*>\s*<a href="(\/tradies\/[^"]+)"\s*>([\s\S]*?)<\/a>/);
    if (!head) continue;
    const trade = chunk.match(/icon-toolbox-solid[^>]*><\/span>\s*([^<]+?)\s*<\/span>/);
    const location = chunk.match(/icon-geo-alt-fill[^>]*><\/span>\s*([^<]+?)\s*<\/span>/);
    const rating = chunk.match(/<span class="me-2 fw-bold">\s*([\d.]+)\s*<\/span>/);
    cards.push({
      name: cleanText(head[2]),
      trade: trade ? cleanText(trade[1]) : '',
      location: location ? cleanText(location[1]) : '',
      rating: rating ? rating[1] : '',
      profile_url: new URL(head[1], BASE).href,
    });
  }
  return cards;
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = typeof keyword === 'string' ? keyword.trim() : '';
  if (!input) return couldnt('other', BASE + '/trades/all', 'empty company name');

  const term = searchTerm(input);
  const key = matchKey(input);
  const firstUrl = buildUrl(term, 1);

  try {
    let total = null;
    let matches = [];
    let matchUrl = firstUrl;
    let seenNames = [];
    let morePages = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) {
        return couldnt('timeout', buildUrl(term, page), 'stopped after 45 s, search not finished');
      }
      const url = buildUrl(term, page);
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-NZ,en;q=0.9',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      const countMatch = html.match(/(\d[\d,]*)\s+results?\s+for\s+"/i);
      const noneFound = /No tradies found/i.test(html);

      if (!countMatch && !noneFound) {
        if (/cf-chl|captcha|Just a moment|Attention Required|Verify you are human/i.test(html)) {
          return couldnt('blocked', url, 'bot check page');
        }
        return couldnt('layout_changed', url, cleanText(html).slice(0, 300));
      }

      if (page === 1) total = countMatch ? Number(countMatch[1].replace(/,/g, '')) : 0;

      const cards = parseCards(html);
      if (total > 0 && cards.length === 0 && page === 1) {
        return couldnt('layout_changed', url, `header says ${total} result(s) but no tradie card parsed`);
      }

      const pageMatches = cards.filter((c) => key && matchKey(c.name) === key);
      seenNames.push(...cards.map((c) => c.name));
      if (pageMatches.length) {
        matches = pageMatches;
        matchUrl = url;
        break;
      }

      // Links in the HTML are written with &amp; (e.g. ...?search_term=Ltd&amp;page=2).
      const hasNext = new RegExp(`(?:\\?|&amp;|&)page=${page + 1}(?!\\d)`).test(html);
      if (!hasNext || cards.length === 0) break;
      if (page === MAX_PAGES) morePages = true;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ name, trade, location, rating, profile_url }) => ({ name, trade, location, rating, profile_url })),
        source_url: matchUrl,
        excerpt: `${matches[0].name} | ${matches[0].trade} | ${matches[0].location} | rating ${matches[0].rating || 'none'}`.slice(0, 500),
      };
    }

    if (morePages) {
      return couldnt('other', firstUrl, `search for "${term}" has ${total} results; the first ${MAX_PAGES} pages were checked and "${input}" was not among them`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Site search for "${term}": ${total ?? 0} tradie result(s), none named "${input}". Names seen: ${seenNames.slice(0, 5).join('; ') || 'none'}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
