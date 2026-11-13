export const meta = {
  task: 'TH-yellowpages.co.th',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'business_id', 'profile_url'],
  canary: { found: 'บริษัท ซีพีโมเดลแอนด์ซายน์ จำกัด', not_found: 'บริษัท ซ็อกซ์ควิซแบซ จำกัด ทดสอบ' },
};

const BASE = 'https://www.yellowpages.co.th';
const SEARCH = `${BASE}/ypsearch`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;          // exact name is normally on page 1; look at most 3 result pages
const PAGE_TIME_LIMIT = 30000; // do not start another result page after 30 s

/** Remove tags and decode the few entities this site uses. Tags are removed without adding spaces, so "<em>ซีพี</em>โมเดล" stays "ซีพีโมเดล". */
function decode(s) {
  return (s || '').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Comparison key: case, spaces, punctuation and legal forms (บริษัท, จำกัด, (มหาชน), Co., Ltd, Sdn Bhd ...) are ignored. */
function norm(s) {
  return decode(s).normalize('NFC').toLowerCase()
    .replace(/\(มหาชน\)|มหาชน|จำกัด|บริษัท|ห้างหุ้นส่วนจำกัด|หจก\.?|\bsdn\.?\s*bhd\.?|\bbhd\b|\bco\.?,?\s*ltd\.?|\bltd\.?|\blimited\b|\bpublic\b|\bpcl\b|\bplc\b|\bcompany\b|\bcorporation\b|\bcorp\b|\binc\b/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/** Listings on one results page: each has a profile link (with business id) and an address line. */
function parseListings(html) {
  const out = [];
  const re = /<h3><a[^>]*?href="([^"]*\/profile\/[^"]*)"[^>]*?data-businessid="(\d+)"[^>]*>([\s\S]*?)<\/a><\/h3>(?:\s*<p class="yp-listing-address">([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({
      name: decode(m[3]),
      address: decode(m[4]),
      business_id: m[2],
      profile_url: new URL(m[1].replace(/&amp;/g, '&'), BASE).href,
    });
  }
  return out;
}

function getPage(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'th,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const firstUrl = `${SEARCH}?q=${encodeURIComponent(keyword)}`;
  const target = norm(keyword);
  try {
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'no name left after removing the legal form' };
    }

    const matches = [];
    let matchUrl = firstUrl;
    let total = null;
    let pagesScanned = 0;
    let morePages = false;
    let lastUrl = firstUrl;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && (!morePages || Date.now() - started > PAGE_TIME_LIMIT)) break;
      const url = page === 0 ? firstUrl : `${firstUrl}&page=${page}`;
      lastUrl = url;
      const res = await getPage(url);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      pagesScanned++;

      // The site's own "no listing" box: a normal answer, the company is not there.
      if (page === 0 && /alert-search-not-found/.test(html)) {
        const sorry = html.match(/<h5 class="txt-cannot-find-word">([\s\S]*?)<\/h5>/);
        return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: decode(sorry ? sorry[1] : 'no listings found').slice(0, 300) };
      }

      const listings = parseListings(html);
      const countMatch = html.match(/ผลการค้นหา\s*([\d,]+)\s*รายการ/);
      if (page === 0) {
        if (!listings.length && !countMatch) {
          const blocked = /incapsula|captcha|access denied|cf-chl|challenge-platform/i.test(html);
          return {
            status: 'couldnt_check',
            reason: blocked ? 'blocked' : 'layout_changed',
            records: [],
            source_url: url,
            excerpt: decode(html).slice(0, 300),
          };
        }
        if (countMatch) total = Number(countMatch[1].replace(/,/g, ''));
      } else if (!listings.length) {
        break; // no more results after all
      }

      const hits = listings.filter((l) => norm(l.name) === target);
      if (hits.length) {
        matches.push(...hits);
        matchUrl = url;
        break;
      }
      morePages = /pager__item--next/.test(html);
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matchUrl,
        excerpt: `${matches[0].name} | ${matches[0].address}`.slice(0, 300),
      };
    }

    if (morePages) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: lastUrl,
        excerpt: `no exact name match in the first ${pagesScanned} result pages of ${total} results; not checked further`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 exact name matches among ${total ?? 0} results`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
