export const meta = {
  task: 'GB-reports.ofsted.gov.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'urn', 'provider_url', 'category', 'address', 'rating', 'latest_report'],
  canary: { found: 'Clinevo Holdings Limited', not_found: 'Dezeno' },
};

const BASE = 'https://reports.ofsted.gov.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower case, accents and punctuation removed, UK legal form removed from the end (so "Ltd" = "Limited"). */
function normalise(name) {
  let s = (name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/ (limited|ltd|llp|plc|cic|lp|company|co)$/, '').trim();
  } while (s !== prev);
  return s;
}

function searchUrl(keyword, start) {
  const q = encodeURIComponent(keyword);
  return start > 0 ? `${BASE}/search?q=${q}&start=${start}` : `${BASE}/search?q=${q}`;
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Fetch one results page. Returns { html } or { fail } (a couldnt_check answer). */
async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: failure(timedOut ? 'timeout' : 'other', url, err && err.message ? err.message : err) };
  }
  if (res.status === 403 || res.status === 429) {
    return { fail: failure('blocked', url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { fail: failure('http_error', url, `HTTP ${res.status}`) };
  }
  let html;
  try {
    html = await res.text();
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: failure(timedOut ? 'timeout' : 'other', url, err && err.message ? err.message : err) };
  }
  return { html };
}

/** Parse one results page into { total, items, noResults } or a layout/blocked failure. */
function parsePage(html, url) {
  if (/There are no results for this search/i.test(html)) {
    return { total: 0, items: [], noResults: true };
  }
  const countMatch = html.match(/results-count js-results-count">\s*([\d,]+)\s*</);
  if (!countMatch || !html.includes('class="search-result">')) {
    if (/captcha|challenge-platform|access denied|are you a robot/i.test(html)) {
      return { fail: failure('blocked', url, html.slice(0, 200)) };
    }
    return { fail: failure('layout_changed', url, html.slice(0, 300)) };
  }
  const total = Number(countMatch[1].replace(/,/g, ''));
  const chunks = html.split('<li class="search-result">').slice(1);
  const items = [];
  for (const chunk of chunks) {
    // One result row ends at the first "</ul></li>" (the provider-info list closed, then the row's <li>).
    const block = (chunk.match(/^[\s\S]*?<\/ul>\s*<\/li>/) || [chunk])[0];
    const title = block.match(/<h3 class="search-result__title[^"]*"><a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!title) continue;
    const pick = (re) => {
      const m = block.match(re);
      return m ? cleanText(m[1]) : '';
    };
    items.push({
      name: cleanText(title[2]),
      provider_url: new URL(decodeEntities(title[1]), BASE).href,
      urn: pick(/URN: <strong>([\s\S]*?)<\/strong>/),
      category: pick(/Category: <strong>([\s\S]*?)<\/strong>/),
      address: pick(/<address class="search-result__address">([\s\S]*?)<\/address>/),
      rating: pick(/Rating: <strong>([\s\S]*?)<\/strong>/),
      latest_report: pick(/Latest report: <strong><time>([\s\S]*?)<\/time>/),
    });
  }
  if (items.length === 0) {
    return { fail: failure('layout_changed', url, 'results count shown but no result rows parsed') };
  }
  return { total, items, noResults: false };
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause before returning lets the keep-alive socket settle: on Windows, Node 24 aborts with
 * "Assertion failed: UV_HANDLE_CLOSING" when the runner calls process.exit while that socket is still open.
 */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const want = normalise(keyword);
    if (!want) return failure('other', searchUrl('', 0), 'empty company name');

    // Page 1 (results are ranked so exact names come first; the site also returns loose matches).
    const url1 = searchUrl(keyword, 0);
    const p1raw = await fetchPage(url1);
    if (p1raw.fail) return p1raw.fail;
    const p1 = parsePage(p1raw.html, url1);
    if (p1.fail) return p1.fail;

    if (p1.noResults) {
      return { status: 'not_found', reason: '', records: [], source_url: url1, excerpt: 'There are no results for this search' };
    }

    const matchesOn = (page, url) => page.items
      .filter((it) => normalise(it.name) === want)
      .map((it) => ({ ...it, search_total: page.total, search_url: url }));

    const total = p1.total;
    let seen = p1.items.length;
    let matches = matchesOn(p1, url1);
    let lastUrl = url1;

    // Page 2 only if page 1 has no exact name and more results exist.
    if (matches.length === 0 && total > seen) {
      const url2 = searchUrl(keyword, PAGE_SIZE);
      const p2raw = await fetchPage(url2);
      if (p2raw.fail) return p2raw.fail;
      const p2 = parsePage(p2raw.html, url2);
      if (p2.fail) return p2.fail;
      matches = matchesOn(p2, url2);
      seen += p2.items.length;
      lastUrl = url2;
    }

    if (matches.length > 0) {
      const records = matches.map((m) => ({
        name: m.name,
        urn: m.urn,
        provider_url: m.provider_url,
        category: m.category,
        address: m.address,
        rating: m.rating,
        latest_report: m.latest_report,
      }));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0].search_url,
        excerpt: `${records[0].name} | ${records[0].category} | URN ${records[0].urn}`.slice(0, 300),
      };
    }

    // No exact name. Not found only if every result the site reports has been seen;
    // otherwise absence is not proven and the answer is couldnt_check.
    if (total <= seen) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: lastUrl,
        excerpt: `${total} loose matches, none with the same name`,
      };
    }
    return failure('other', lastUrl, `search returns ${total} loose matches; exact name not in the first ${seen}`);
  } catch (err) {
    return failure('other', searchUrl(keyword, 0), err && err.message ? err.message : err);
  }
}
