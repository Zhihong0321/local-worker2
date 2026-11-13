export const meta = {
  task: 'GB-freeindex.co.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'street', 'locality', 'region', 'postcode', 'listing_locality', 'rating', 'review_count', 'profile_url'],
  canary: { found: 'Dressed To Impress', not_found: 'Dezeno Quorvexly Zzq' },
};

const BASE = 'https://www.freeindex.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BUDGET_MS = 50000;     // stay well under the 60 s limit for the whole call
const MAX_PAGES = 4;         // search page 1 plus up to 3 "Show More Results" pages
const MAX_PROFILES = 3;      // profile pages read per lookup
const LEGAL_FORMS = new Set(['ltd', 'limited', 'llp', 'plc', 'cic']);

class BudgetError extends Error {}

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised company name: case, punctuation, "&"/"and" and the legal form are ignored. */
function normName(s) {
  return decode(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

function cc(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || '', excerpt: String(excerpt).slice(0, 300) };
}

function looksBlocked(html) {
  return /captcha|cf-chl|Just a moment|Access denied|Attention Required|Verify you are human/i.test(html)
    && !/listing_name|Search results for/i.test(html);
}

async function get(url, started, accept) {
  if (BUDGET_MS - (Date.now() - started) < 3000) throw new BudgetError('time budget used up');
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Parse one block of search result listings (the search page or an ajax "Show More" fragment). */
function parseListings(html) {
  const out = [];
  for (const block of html.split('<div class="listing">').slice(1)) {
    const link = block.match(/<div class="listing_name">[\s\S]*?<a href="(\/profile\([^"]*\)_\d+\.htm)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const name = clean(link[2]);
    const locMatch = block.match(/<span class="listing_locality">([\s\S]*?)<\/span>/);
    const listingLocality = locMatch ? clean(locMatch[1].replace(/<a[\s\S]*?<\/a>/, '')) : '';
    const rating = block.match(/Average rating of ([\d.]+) based on ([\d,]+) reviews/);
    out.push({
      name,
      truncated: /\.\.\.$|…$/.test(name),
      profile_path: link[1],
      listing_locality: listingLocality,
      rating: rating ? Number(rating[1]) : null,
      review_count: rating ? Number(rating[2].replace(/,/g, '')) : null,
    });
  }
  return out;
}

function hidden(html, id) {
  const m = html.match(new RegExp(`<input type="hidden" id="${id}" value="([^"]*)"`));
  return m ? decode(m[1]) : '';
}

/** Read a profile page: full business name, category and the address in its schema.org block. */
function parseProfile(html, profileUrl) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const name = h1 ? clean(h1[1]) : '';
  const title = clean((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const parts = title.split('|').map((s) => s.trim());
  const category = parts.length >= 3 ? parts[1] : '';
  const addr = html.match(/"address":\s*\{([^}]*)\}/);
  const field = (key) => {
    const m = addr ? addr[1].match(new RegExp(`"${key}":\\s*"([^"]*)"`)) : null;
    return m ? decode(m[1]) : '';
  };
  return {
    name,
    category,
    street: field('streetAddress'),
    locality: field('addressLocality'),
    region: field('addressRegion'),
    postcode: field('postalCode'),
    profile_url: profileUrl,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let searchUrl = '';
  try {
    const kw = String(keyword || '').trim();
    const wanted = normName(kw);
    if (!wanted) return cc('other', 'empty company name', '');

    // Same query string the site's own search box builds.
    const k = kw.toLowerCase().replace(/[*"]/g, '').trim().replace(/\s+/g, '_').replace(/&/g, '|and|');
    searchUrl = `${BASE}/searchresults.htm?k=${encodeURIComponent(k)}&v=a!B`;

    const res = await get(searchUrl, started);
    if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`, searchUrl);
    if (!res.ok) return cc('http_error', `HTTP ${res.status}`, searchUrl);
    const html = await res.text();
    if (looksBlocked(html)) return cc('blocked', 'bot or captcha check page', searchUrl);
    if (!/Search results for/i.test(html)) return cc('layout_changed', html.slice(0, 300), searchUrl);

    const ctx = { catid: hidden(html, 'catid'), cat: hidden(html, 'cat'), loc: hidden(html, 'loc') };
    let seen = parseListings(html);
    let candidates = seen.filter((l) => matchesByListingName(l, wanted));
    let lastCount = seen.length;
    let page = 1;

    // Only page further when page 1 has no match and the last page still had listings.
    while (candidates.length === 0 && lastCount > 0 && page < MAX_PAGES) {
      page += 1;
      const moreUrl = `${BASE}/customscripts/ajax_listings.asp?catid=${encodeURIComponent(ctx.catid)}`
        + `&cat=${encodeURIComponent(ctx.cat)}&loc=${encodeURIComponent(ctx.loc)}&lt=SEARCH&ft=&id=&p=${page}`;
      const r = await get(moreUrl, started, '*/*');
      if (!r.ok) return cc('http_error', `HTTP ${r.status} on results page ${page}`, moreUrl);
      const frag = await r.text();
      const more = parseListings(frag);
      lastCount = more.length;
      seen = seen.concat(more);
      candidates = seen.filter((l) => matchesByListingName(l, wanted));
    }

    if (seen.length === 0) {
      if (/no results matching your current search/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
          excerpt: `Sorry, but there are no results matching your current search for "${kw}"` };
      }
      return cc('layout_changed', 'no listings and no known empty-result text', searchUrl);
    }

    const records = [];
    for (const cand of candidates.slice(0, MAX_PROFILES)) {
      const profileUrl = new URL(cand.profile_path, BASE).href;
      let rec = null;
      try {
        const pr = await get(profileUrl, started);
        if (!pr.ok) {
          if (cand.truncated) return cc('http_error', `HTTP ${pr.status} on profile`, profileUrl);
        } else {
          const profile = parseProfile(await pr.text(), profileUrl);
          if (normName(profile.name) === wanted) rec = { ...profile, listing_locality: cand.listing_locality,
            rating: cand.rating, review_count: cand.review_count };
        }
      } catch (err) {
        if (cand.truncated) throw err;
      }
      // Profile unavailable but the listing name matched in full: keep the listing-level record.
      if (!rec && !cand.truncated) {
        rec = { name: cand.name, category: '', street: '', locality: '', region: '', postcode: '',
          listing_locality: cand.listing_locality, rating: cand.rating, review_count: cand.review_count,
          profile_url: profileUrl };
      }
      if (rec) records.push(rec);
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${seen.length} listings checked on ${page} results page(s), none named "${kw}"` };
    }
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.profile_url,
      excerpt: [first.name, first.category, first.review_count != null ? `${first.review_count} reviews` : '',
        [first.street, first.locality, first.region, first.postcode].filter(Boolean).join(', ')]
        .filter(Boolean).join(' | ').slice(0, 300),
    };
  } catch (err) {
    const n = err && err.name;
    const reason = (n === 'TimeoutError' || n === 'AbortError' || err instanceof BudgetError) ? 'timeout' : 'other';
    return cc(reason, String(err && err.message ? err.message : err), searchUrl);
  }
}

function matchesByListingName(listing, wanted) {
  const base = listing.truncated ? listing.name.replace(/(\.\.\.|…)$/, '').trim() : listing.name;
  const nn = normName(base);
  if (!nn) return false;
  // A cut-off name can only be a prefix; the profile page then confirms the full name.
  return listing.truncated ? wanted.startsWith(nn) : nn === wanted;
}
