export const meta = {
  task: 'NL-marktplaats.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'seller_id', 'is_verified', 'listings_on_page'],
  canary: { found: 'Catawiki', not_found: 'Blauwgrijsxqzvtplm B.V.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form tokens at the end of a name, e.g. "ACME B.V.", "ACME BV", "ACME N.V.", "ACME VOF".
const LEGAL_FORM = /[\s,]+(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?|e\.?\s?e\.?|eenmanszaak|vof)\.?$/i;

/** Remove trailing legal-form tokens, repeatedly. Keeps the original if nothing is left. */
function coreName(str) {
  let s = (str || '').trim().replace(/\s+/g, ' ');
  let prev;
  do {
    prev = s;
    s = s.replace(LEGAL_FORM, '').trim();
  } while (s !== prev && s.length > 0);
  return s || (str || '').trim();
}

/** Compare form: lower case, no accents, letters and digits only. */
function normalize(str) {
  return coreName(str).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sellersFromHtml(html) {
  const sellers = [];
  const re = /"sellerInformation":(\{[^{}]*\})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const s = JSON.parse(m[1]);
      if (s && typeof s.sellerName === 'string') sellers.push(s);
    } catch {
      /* skip a fragment that is not valid JSON */
    }
  }
  return sellers;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const core = coreName(keyword);
    searchUrl = `https://www.marktplaats.nl/q/${encodeURIComponent(core)}/`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|datadome|verify you are human|challenge-platform/i.test(html) && !/totalResultCount/.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
    }

    const totalMatch = html.match(/"totalResultCount":(\d+)/);
    const emptyText = html.match(/geen resultaten gevonden[^<"]{0,80}/i);
    if (!totalMatch && !emptyText) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: html.slice(0, 300) };
    }

    const total = totalMatch ? Number(totalMatch[1]) : 0;
    if (total === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: emptyText ? emptyText[0].trim() : 'totalResultCount 0',
      };
    }

    const want = normalize(keyword);
    const sellers = sellersFromHtml(html);
    const matches = new Map();
    for (const s of sellers) {
      if (normalize(s.sellerName) !== want) continue;
      const key = String(s.sellerId);
      if (!matches.has(key)) {
        matches.set(key, { name: s.sellerName, seller_id: s.sellerId, is_verified: !!s.isVerified, listings_on_page: 0 });
      }
      matches.get(key).listings_on_page += 1;
    }

    if (matches.size > 0) {
      const records = [...matches.values()];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `Seller account "${records[0].name}" (id ${records[0].seller_id}) has ${records[0].listings_on_page} listing(s) on the search page; search total ${total}`,
      };
    }

    // The search returned ads, but no seller account with this name is among them. That does not prove the
    // company is absent (its ads may not mention the name), so say so instead of calling it not_found.
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: `Search returned ${total} ads but no seller account named "${core}" among ${sellers.length} seller entries on the page`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
