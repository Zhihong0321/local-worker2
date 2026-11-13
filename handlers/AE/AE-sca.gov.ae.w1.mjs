// Handler for AE-sca.gov.ae (the SCA site now redirects to the UAE Capital Market Authority, uaecma.gov.ae).
// Searches the public "Licensed Companies" register (open-data) by keyword, then keeps only exact name matches.
// Steps: (1) GET the public page to receive the site's anonymous anti-forgery token (cookie + hidden field),
// (2) POST the same keyword-search call the page's own search box makes, sending that token back.

export const meta = {
  task: 'AE-sca.gov.ae',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'code', 'status', 'website', 'year'],
  canary: { found: 'Abu Dhabi Commercial Bank', not_found: 'شركة الفجر المستحيلة للتجارة ذ.م.م' },
};

const BASE = 'https://www.uaecma.gov.ae';
const PAGE = BASE + '/en/open-data/licensed-companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words at the end of a company name (English and Arabic forms), removed before comparing.
const LEGAL_SUFFIX = /\s+(?:p\.?\s?j\.?\s?s\.?\s?c|p\.?\s?s\.?\s?c|l\.?\s?l\.?\s?c|llc|llp|fzc|fze|fzllc|sdn\.?\s?bhd|bhd|ltd|limited|sole\s+proprietorship|ش\.?\s?م\.?\s?ع|ذ\.?\s?م\.?\s?م)\.?$/i;

/** The name without brackets, commas, or a trailing legal form (repeated, e.g. "... SOLE PROPRIETORSHIP P.S.C"). */
function coreName(s) {
  let t = String(s || '').normalize('NFKC').replace(/[()\[\],]/g, ' ').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = t.replace(LEGAL_SUFFIX, '').trim();
    if (next === t || next === '') break;
    t = next;
  }
  return t;
}

/** Comparison key: lower case, letters and digits only. */
function key(s) {
  return coreName(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** "name=value" pairs from every Set-Cookie header, joined for a Cookie request header. */
function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return list.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const typed = String(keyword || '').trim();
    if (!typed) return fail('other', PAGE, 'empty company name');

    // Search term = the name without its legal form (the site lists names like "... (P.J.S.C)").
    const term = coreName(typed) || typed;
    const searchUrl = `${PAGE}?keyword=${encodeURIComponent(term)}`;

    // 1. The public page. Every visitor gets an anti-forgery token in a cookie and a hidden field.
    const pageRes = await fetch(PAGE, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return fail('blocked', PAGE, `HTTP ${pageRes.status}`);
    }
    if (!pageRes.ok) return fail('http_error', PAGE, `HTTP ${pageRes.status}`);

    const pageHtml = await pageRes.text();
    const tokenMatch = pageHtml.match(/name="__RequestVerificationToken" value="([^"]+)"/);
    if (!tokenMatch || !pageHtml.includes('Licensed Companies')) {
      return fail('layout_changed', PAGE, pageHtml.slice(0, 200));
    }
    const token = tokenMatch[1];
    const cookie = cookieHeader(pageRes);

    // 2. The keyword search the page's own search box sends. The register has double spaces in some names
    //    ("NATIONAL BONDS  CORPORATION"), which break a long keyword, so a shorter fallback is tried too.
    const candidates = [term];
    const words = term.split(' ');
    if (words.length > 2) candidates.push(words.slice(0, 2).join(' '));

    const wanted = key(term);
    const found = new Map();
    let tooMany = 0;
    for (const q of candidates) {
      if (Date.now() - started > 40000) {
        return fail('timeout', searchUrl, 'out of time before every search ran');
      }
      const apiRes = await fetch(`${BASE}/api/PublicApi/GeIntegrationResult`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Origin': BASE,
          'Referer': PAGE,
          'Cookie': cookie,
          'RequestVerificationToken': token,
        },
        body: JSON.stringify({
          integrationId: 2045,
          urlParameters: { pageIndex: 1, pageSize: 200, keyword: q, languageId: 1, languageCode: 'en-GB' },
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (apiRes.status === 403 || apiRes.status === 429) {
        return fail('blocked', searchUrl, `HTTP ${apiRes.status}`);
      }
      if (!apiRes.ok) return fail('http_error', searchUrl, `HTTP ${apiRes.status}`);

      let json;
      try {
        json = JSON.parse(await apiRes.text());
      } catch {
        return fail('layout_changed', searchUrl, 'search answer is not JSON');
      }
      if (!json || json.code !== 200 || !json.data || !Array.isArray(json.data.items)) {
        return fail('layout_changed', searchUrl, JSON.stringify(json).slice(0, 300));
      }

      const items = json.data.items;
      // The site's "total" is unreliable (it says 1 for an empty list), so a full page (200) is the truncation sign.
      if (items.length >= 200) tooMany = items.length;
      // Exact match on the normalised name (case, punctuation and legal form ignored), not a similar word.
      for (const item of items) {
        if (item && key(item.name) === wanted) found.set(item.code || item.name, item);
      }
      if (found.size > 0) break;
    }

    if (found.size === 0 && tooMany) {
      return fail('other', searchUrl, `${tooMany} keyword hits, too many to check every one`);
    }
    if (found.size === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `0 matching entries for "${term}" in the licensed companies register`,
      };
    }

    const matches = [...found.values()];
    const records = matches.map((item) => ({
      name: String(item.name || '').replace(/\s+/g, ' ').trim(),
      code: item.code || '',
      status: item.status || '',
      website: item.website || '',
      year: item.year || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => `${r.name} | ${r.code} | ${r.status}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', PAGE, String((err && err.message) || err));
  }
}
