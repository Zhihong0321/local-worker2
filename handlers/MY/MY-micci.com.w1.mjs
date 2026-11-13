export const meta = {
  task: 'MY-micci.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'phone', 'address', 'website', 'listing_url'],
  canary: { found: 'AAK MALAYSIA SDN BHD', not_found: 'Syarikat Tiada Wujud Sdn Bhd' },
};

const BASE = 'https://www2.micci.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;
const BUDGET_MS = 50000; // the whole lookup must finish in under 60 s

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Compare names: case, punctuation and the spelling of the legal form do not matter.
function normName(s) {
  return clean(s)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bBERHAD\b/g, 'BHD')
    .replace(/\s+/g, ' ')
    .trim();
}

// The site's search fails on punctuation ("SDN." or "(MALAYSIA)"), so send letters, digits and spaces only.
function searchQuery(keyword) {
  return clean(String(keyword || '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

function pageUrl(page, q) {
  const params = new URLSearchParams({ q }).toString();
  return page === 1 ? `${BASE}/search-result/?${params}` : `${BASE}/search-result/page/${page}/?${params}`;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function getPage(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 2000) return { error: 'timeout', excerpt: 'the lookup ran out of its 50 s budget' };
  let res;
  let html;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(Math.min(25000, remaining)),
    });
    if (res.status === 403 || res.status === 429) return { error: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { error: 'http_error', excerpt: `HTTP ${res.status}` };
    html = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e) };
  }
  // A bot check page has no directory markup at all.
  if (!/directorist/i.test(html) && /captcha|cf-chl|Just a moment|challenge-platform/i.test(html)) {
    return { error: 'blocked', excerpt: 'bot check page' };
  }
  return { html };
}

// Each listing card: title + link, then phone, address and website list items.
function parseCards(html) {
  const cards = [];
  const seen = new Set();
  const parts = html.split('<h2 class="directorist-listing-title">').slice(1);
  for (const part of parts) {
    const m = part.match(/^<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const chunk = part.split('</article>')[0].slice(0, 6000);
    const phone = chunk.match(/directorist-listing-card-phone"[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/);
    const address = chunk.match(/directorist-listing-card-address"[^>]*>([\s\S]*?)<\/li>/);
    const website = chunk.match(/directorist-listing-card-website"[\s\S]*?href="([^"]+)"/);
    cards.push({
      name: clean(m[2]),
      listing_url: m[1],
      phone: phone ? clean(phone[1]) : '',
      address: address ? clean(address[1]) : '',
      website: website ? website[1] : '',
    });
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + BUDGET_MS;
  try {
    const q = searchQuery(keyword);
    if (!q) return couldnt('other', BASE, 'empty company name after removing punctuation');

    const wanted = normName(keyword);
    let url = pageUrl(1, q);
    const first = await getPage(url, deadline);
    if (first.error) return couldnt(first.error, url, first.excerpt);
    if (!/directorist/i.test(first.html)) return couldnt('layout_changed', url, clean(first.html).slice(0, 300));

    // Total pages of results, from the pagination links on page 1.
    const pageNums = [...first.html.matchAll(/search-result\/page\/(\d+)\//g)].map((x) => Number(x[1]));
    const totalPages = pageNums.length ? Math.max(...pageNums) : 1;

    let page = 1;
    let html = first.html;
    let cards = parseCards(html);
    let matches = cards.filter((c) => normName(c.name) === wanted);
    let listedCount = cards.length;

    while (matches.length === 0 && page < totalPages) {
      page += 1;
      if (page > MAX_PAGES) {
        return couldnt('other', pageUrl(1, q),
          `search has ${totalPages} pages of results; only the first ${MAX_PAGES} were checked, so not_found cannot be claimed`);
      }
      url = pageUrl(page, q);
      const next = await getPage(url, deadline);
      if (next.error) return couldnt(next.error, url, next.excerpt);
      html = next.html;
      if (!/directorist/i.test(html)) return couldnt('layout_changed', url, clean(html).slice(0, 300));
      cards = parseCards(html);
      listedCount += cards.length;
      matches = cards.filter((c) => normName(c.name) === wanted);
    }

    if (matches.length === 0) {
      if (listedCount === 0 && !/No listings found/i.test(html)) {
        return couldnt('layout_changed', url, clean(html).slice(0, 300));
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl(1, q),
        excerpt: `search "${q}" returned ${listedCount} listing(s); none is named "${clean(keyword)}"`.slice(0, 300),
      };
    }

    const records = matches.map((c) => ({
      name: c.name,
      phone: c.phone,
      address: c.address,
      website: c.website,
      listing_url: c.listing_url,
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: `${matches[0].name} | ${matches[0].address} | ${matches[0].phone}`.slice(0, 300),
    };
  } catch (err) {
    return couldnt('other', pageUrl(1, searchQuery(keyword)), String(err?.message || err));
  }
}
