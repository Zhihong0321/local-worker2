export const meta = {
  task: 'IN-mouthshut.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'profile_url', 'avg_rating', 'votes', 'recommend_pct'],
  canary: { found: 'Tata Motors Ltd', not_found: 'Zzqxv Nonexistent Kbl Pvt Ltd' },
};

// MouthShut's product search page fills its results in with this fragment endpoint (the page's own JavaScript
// calls it: /search/prodsrch_loadmore_ajax.aspx?currentpage=N&data=QUERY). The fragment is plain HTML.
const BASE = 'https://www.mouthshut.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'plc', 'opc']);
const MAX_PAGES = 2; // page 1 and page 2 of the results at most, so two 25 s fetches stay under the 60 s limit

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Lower-case words of a name, punctuation removed, legal form removed. Used to compare names. */
function normWords(s) {
  return cleanText(s).toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter((w) => w && !LEGAL.has(w));
}

function normName(s) {
  return normWords(s).join('');
}

/** The keyword as typed, minus the legal form, is what goes to the site search (the site misses "Infosys Limited"). */
function searchQuery(keyword) {
  return cleanText(keyword).replace(/[.,()'"\/\\-]+/g, ' ').split(/\s+/).filter((w) => w && !LEGAL.has(w.toLowerCase())).join(' ');
}

function searchPage(query) {
  return `${BASE}/search/prodsrch.aspx?data=${encodeURIComponent(query)}&type=&p=0`;
}

function fragmentUrl(query, page) {
  const u = new URL('/search/prodsrch_loadmore_ajax.aspx', BASE);
  u.searchParams.set('currentpage', String(page));
  u.searchParams.set('data', query);
  u.searchParams.set('gsearch', '0');
  u.searchParams.set('id', '0');
  u.searchParams.set('p', '0');
  u.searchParams.set('type', '');
  u.searchParams.set('is_employer', '0');
  u.searchParams.set('parent2', '');
  return u.href;
}

function requestHeaders(query) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html, */*; q=0.01',
    'Accept-Language': 'en-IN,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': searchPage(query),
  };
}

function isBlockPage(html) {
  return /cf-chl|Just a moment\.\.\.|Enable JavaScript and cookies to continue/i.test(html);
}

/** One product card per result. Ad boxes have no product link and are skipped. */
function parseItems(html) {
  const items = [];
  for (const chunk of html.split('class="box product"').slice(1)) {
    const a = chunk.match(/id="[^"]*_hypProduct"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const cat = chunk.match(/id="[^"]*_hypParent"[^>]*>([\s\S]*?)<\/a>/i);
    const rating = chunk.match(/avg-star">\s*([\d.]+)/i);
    const votes = chunk.match(/([\d,]+)\s*Votes/i);
    const rec = chunk.match(/icon-like[^>]*><\/span>\s*(\d+(?:\.\d+)?)\s*%/i);
    items.push({
      name: cleanText(a[2]),
      category: cat ? cleanText(cat[1]) : '',
      profile_url: new URL(a[1], BASE).href,
      avg_rating: rating ? rating[1] : '',
      votes: votes ? votes[1].replace(/,/g, '') : '',
      recommend_pct: rec ? rec[1] : '',
    });
  }
  return items;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let query = '';
  try {
    query = searchQuery(String(keyword || ''));
    const want = normName(String(keyword || ''));
    if (!query || !want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no name left to search after removing the legal form' };
    }
    const pageUrl = searchPage(query);
    const seen = [];
    let exact = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(fragmentUrl(query, page), { headers: requestHeaders(query), signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      if (isBlockPage(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: 'bot check page' };
      }

      // The site's own "no results" message: a normal answer, the company is not listed.
      if (/id="lblnoresults"/.test(html)) {
        if (page === 0) {
          return { status: 'not_found', reason: '', records: [], source_url: pageUrl,
            excerpt: `The site search returned its no-results message for "${query}"` };
        }
        break;
      }

      const items = parseItems(html);
      if (items.length === 0) {
        if (page === 0 && /id="srchresults"/.test(html)) {
          // An empty container without the site's no-results message: we cannot tell "not listed" from "not searched".
          return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl,
            excerpt: 'the result container came back empty without the no-results message' };
        }
        if (page === 0) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: html.slice(0, 300) };
        }
        break;
      }

      seen.push(...items);
      exact = seen.filter((i) => normName(i.name) === want);
      if (exact.length) break;
      if (!/page-item next/i.test(html)) break;
    }

    if (exact.length) {
      return {
        status: 'found',
        reason: '',
        records: exact.map(({ name, category, profile_url, avg_rating, votes, recommend_pct }) =>
          ({ name, category, profile_url, avg_rating, votes, recommend_pct })),
        source_url: pageUrl,
        excerpt: `${exact[0].name} | ${exact[0].category} | rating ${exact[0].avg_rating} | ${exact[0].votes} votes`,
      };
    }

    const near = seen.slice(0, 3).map((i) => i.name).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `${seen.length} results checked, none with this name${near ? ` (first results: ${near})` : ''}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: query ? searchPage(query) : `${BASE}/search/prodsrch.aspx`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
