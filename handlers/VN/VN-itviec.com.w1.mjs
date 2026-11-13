export const meta = {
  task: 'VN-itviec.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'city', 'rating'],
  canary: { found: 'FPT IS', not_found: 'Công ty TNHH Không Tồn Tại Xyz Qwe' },
};

const BASE = 'https://itviec.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
};

// Legal-form words, removed from the query the site sees (longest first).
const LEGAL_IN_QUERY = [
  'Công ty TNHH', 'Công ty Cổ phần', 'Công ty CP', 'Công ty', 'Cổ phần',
  'Trách nhiệm hữu hạn', 'TNHH', 'Co\\.?,?\\s*Ltd\\.?', 'Pte\\.?\\s*Ltd\\.?', 'Ltd\\.?', 'Limited',
  'JSC', 'LLC', 'Inc\\.?', 'Corporation', 'Corp\\.?', 'Company', 'MTV', 'Co\\.',
];
const QUERY_STRIP = new RegExp(`(?<!\\p{L})(${LEGAL_IN_QUERY.join('|')})(?!\\p{L})`, 'giu');

// Legal-form words, removed when comparing names (already folded to a-z0-9 and single spaces).
const LEGAL_FOLDED = [
  'trach nhiem huu han', 'cong ty', 'co phan', 'one member', 'mot thanh vien',
  'tnhh', 'cp', 'jsc', 'llc', 'ltd', 'limited', 'inc', 'corp', 'corporation', 'company', 'co', 'mtv', 'pte',
];

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

function matchKey(s) {
  let t = fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
  for (const w of LEGAL_FOLDED) t = t.replace(new RegExp(`(^| )${w}(?= |$)`, 'g'), ' ');
  return t.replace(/ /g, '');
}

function queryFrom(keyword) {
  return String(keyword || '').replace(QUERY_STRIP, ' ').replace(/\s+/g, ' ').replace(/^[\s,.|-]+|[\s,.|-]+$/g, '').trim();
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Each company card on a search result page: name, company path, city and star rating. */
function parseCards(html) {
  const cards = [];
  const parts = html.split('<a class="featured-company').slice(1);
  for (const part of parts) {
    const href = part.match(/href="(\/companies\/[^"?#]+?)(?:\/review)?"/);
    const name = part.match(/company__name[^>]*>([^<]*)<\/h4>/);
    if (!href || !name) continue;
    const city = part.match(/company__footer-city[^>]*>([^<]*)</);
    const rating = part.match(/company__star-rate[^>]*>([^<]*)</);
    cards.push({
      name: decode(name[1]),
      url: BASE + href[1],
      city: city ? decode(city[1]) : '',
      rating: rating && /^\d(\.\d)?$/.test(decode(rating[1])) ? decode(rating[1]) : '',
    });
  }
  return cards;
}

// Known limit (tested 2026-11-13): the site's own search returns 0 results for some full names it does list,
// e.g. "Ngân hàng Á Châu" (not_found) while "Ngân Hàng Á Châu | ACB" and "ACB" are found. A 0-result answer is
// therefore recorded as not_found with the query in the excerpt, so the hub can see what was searched.

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const query = queryFrom(keyword);
  const searchUrl = `${BASE}/companies?query=${encodeURIComponent(query)}`;
  try {
    if (!matchKey(query)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'no company name left after removing legal form' };
    }

    const res = await fetch(searchUrl, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const finalUrl = res.url || searchUrl;
    const html = await res.text();

    if (res.status === 403 || res.status === 429 || /cf-chl|challenge-platform|Just a moment\.\.\./i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: finalUrl, excerpt: `HTTP ${res.status}` };
    }
    if (res.status >= 500 || (res.status >= 400 && res.status !== 404)) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: finalUrl, excerpt: `HTTP ${res.status}` };
    }

    const title = decode((html.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1]);

    // The site sends an exact slug straight to the company page: "FPT IS - IT Jobs | ITviec".
    const companyPage = title.match(/^(.*) - IT Jobs \| ITviec$/);
    if (companyPage) {
      const name = companyPage[1].trim();
      if (matchKey(name) === matchKey(query)) {
        return {
          status: 'found', reason: '',
          records: [{ name, url: finalUrl, city: '', rating: '' }],
          source_url: finalUrl,
          excerpt: title,
        };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: finalUrl,
        excerpt: `search for "${query}" went to the company page "${name}", which is not the same name`,
      };
    }

    // Search result page (or the site's own empty page, which may be HTTP 404).
    if (!/Companies in Vietnam - ITviec\s*$/.test(title) || !/id="query"/.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl, excerpt: title.slice(0, 200) };
    }

    const cards = parseCards(html);
    if (cards.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: finalUrl,
        excerpt: `0 results for "${query}" (HTTP ${res.status})`,
      };
    }

    const want = matchKey(query);
    const matches = cards.filter((c) => matchKey(c.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: finalUrl,
        excerpt: `${cards.length} results for "${query}", none with this name: ${cards.slice(0, 5).map((c) => c.name).join(' | ')}`,
      };
    }
    return {
      status: 'found', reason: '',
      records: matches.map(({ name, url, city, rating }) => ({ name, url, city, rating })),
      source_url: finalUrl,
      excerpt: `${matches.length} match(es) for "${query}" among ${cards.length} results`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
