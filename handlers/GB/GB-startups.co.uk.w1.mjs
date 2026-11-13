export const meta = {
  task: 'GB-startups.co.uk',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'rank', 'list', 'sponsored', 'published', 'profile_url'],
  canary: { found: 'Sampl Technologies Ltd', not_found: 'Qzvorelt Nimbusan Holdings Ltd' },
};

// Startups.co.uk publishes no company register. The only company-level list is the Startups 100 (editorial ranking,
// some entries marked "Sponsored"). This handler checks a name against that list and nothing else.
const BASE = 'https://startups.co.uk/startups-100/2026/';
const LIST_NAME = 'Startups 100 2026';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'cic', 'cio', 'llc', 'inc']);
const MAX_PAGES = 30;

function nameKey(str) {
  const tokens = (str || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

function decode(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0?39;|&#8217;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every list card on a page: rank, name as written, profile URL, sponsored flag, published date. */
function parseCards(html) {
  const out = [];
  for (const card of html.match(/<li class="card-list__item">[\s\S]*?<\/li>/g) || []) {
    const t = card.match(/<a href="([^"]+)" class="article-card__title">\s*<span>\s*(\d+)\.\s*([\s\S]*?)<\/span>/);
    if (!t) continue;
    const time = card.match(/<time class="article-card__post-date">[\s\S]*?<\/i>([\s\S]*?)<\/time>/);
    out.push({
      url: new URL(t[1], BASE).href,
      rank: Number(t[2]),
      name: decode(t[3]),
      sponsored: /article-card__sponsored/.test(card),
      published: time ? decode(time[1]) : '',
    });
  }
  return out;
}

/** Fetch one page. Never throws: returns { html } or { problem: reason, detail } or { missing: true }. */
async function get(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { problem: 'blocked', detail: `HTTP ${res.status} at ${url}` };
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { problem: 'http_error', detail: `HTTP ${res.status} at ${url}` };
    return { html: await res.text() };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { problem: 'timeout', detail: `no answer from ${url} in 25 s` };
    return { problem: 'other', detail: String(err?.message || err).slice(0, 200) };
  }
}

const CHALLENGE = /captcha|just a moment|challenge-platform|access denied/i;

/** Returns a couldnt_check reason if the page is a block or a page that is not the list, otherwise null. */
function pageProblem(html) {
  if (CHALLENGE.test(html) && parseCards(html).length === 0) return 'blocked';
  return null;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = nameKey(keyword);
    if (!key) return fail('other', BASE, 'the company name has no letters or digits');

    // Round 1: the first list page tells how many list pages there are.
    const first = await get(BASE);
    if (first.problem) return fail(first.problem, BASE, first.detail);
    if (first.missing) return fail('layout_changed', BASE, 'HTTP 404 on the Startups 100 list page');
    const firstProblem = pageProblem(first.html);
    if (firstProblem) return fail(firstProblem, BASE, 'the list page is a bot check or block page');

    const pageNumbers = [...first.html.matchAll(/\/startups-100\/2026\/page\/(\d+)\//g)].map((m) => Number(m[1]));
    const lastPage = Math.min(MAX_PAGES, Math.max(1, ...pageNumbers));

    // Round 2: the featured main page (holds rank 100) and list pages 2..lastPage, all at once.
    const indexUrls = [BASE, ...Array.from({ length: lastPage - 1 }, (_, i) => `${BASE}page/${i + 2}/`)];
    const [mainPage, ...restPages] = await Promise.all([
      get(`${BASE}main-page/`),
      ...indexUrls.slice(1).map((u) => get(u)),
    ]);
    const indexPages = [first, ...restPages];

    // Any block, timeout or HTTP error means we cannot say the company is absent.
    for (const p of [mainPage, ...indexPages]) {
      if (p.problem) return fail(p.problem, BASE, p.detail);
    }
    if (mainPage.missing) return fail('layout_changed', `${BASE}main-page/`, 'HTTP 404 on the Startups 100 main page');
    const mainProblem = pageProblem(mainPage.html);
    if (mainProblem) return fail(mainProblem, `${BASE}main-page/`, 'the main page is a bot check or block page');

    // The list is contiguous: pages up to the last one with cards must all have cards. Later pages may be empty.
    const indexCards = indexPages.map((p) => (p.missing ? [] : parseCards(p.html)));
    let lastFull = 0;
    indexCards.forEach((cards, i) => { if (cards.length > 0) lastFull = i; });
    for (let i = 0; i <= lastFull; i++) {
      if (indexPages[i].missing || indexCards[i].length === 0) {
        return fail('layout_changed', indexUrls[i], `list page ${i + 1} has no entries, but later pages do`);
      }
    }

    const entries = new Map();
    for (const card of [...parseCards(mainPage.html), ...indexCards.slice(0, lastFull + 1).flat()]) {
      entries.set(card.url, card);
    }
    if (entries.size < 50) {
      return fail('layout_changed', BASE, `only ${entries.size} entries parsed from the Startups 100 list`);
    }

    const matches = [...entries.values()].filter((e) => nameKey(e.name) === key);
    if (matches.length > 0) {
      const top = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map((e) => ({
          name: e.name,
          rank: e.rank,
          list: LIST_NAME,
          sponsored: e.sponsored,
          published: e.published,
          profile_url: e.url,
        })),
        source_url: top.url,
        excerpt: `${top.rank}. ${top.name}${top.sponsored ? ' (Sponsored)' : ''} - ${top.published}`.slice(0, 300),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: BASE,
      excerpt: `Checked ${entries.size} entries on the ${LIST_NAME} list; no name matched`,
    };
  } catch (err) {
    return fail('other', BASE, String(err?.message || err));
  }
}
