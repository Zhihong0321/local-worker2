export const meta = { task: 'VN-thitruongsi.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'id', 'slug', 'shop_url', 'address', 'province', 'city', 'phone', 'email', 'website', 'status',
    'review_status', 'business_type', 'main_products', 'created_at', 'updated_at'],
  canary: { found: 'CÔNG TY TNHH ALTEK CABLE', not_found: 'Công ty TNHH Thương mại Xyzqwv Không Tồn Tại' } };

// The site's own shop search (the API behind https://thitruongsi.com/shop/search). Plain GET, JSON answer.
// Notes from probing: `keyword` is the search parameter (`q` is ignored), `limit` is capped at 500 and `offset` pages.
const API = 'https://api.thitruongsi.com/v2/search/shops';
const SHOP_PAGE = 'https://thitruongsi.com/shop/';
const PAGE = 500;          // largest page the API accepts
const MAX_SCAN = 5000;     // most results read before we stop; beyond this "not found" cannot be proven
const BUDGET_MS = 30000;   // no new page after 30 s (each fetch may take up to 25 s, so the call ends under 60 s)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change which company it is. Longest first. Whole-phrase removal only, so that
// a name word such as "Hàn" in "Việt Hàn" is never dropped.
const LEGAL_PHRASES = [
  'cong ty trach nhiem huu han mot thanh vien', 'cong ty trach nhiem huu han', 'cong ty tnhh mot thanh vien',
  'cong ty co phan', 'cong ty tnhh', 'trach nhiem huu han', 'mot thanh vien', 'joint stock company',
  'company limited', 'co ltd', 'sdn bhd', 'cong ty', 'tnhh', 'co phan', 'mtv', 'jsc', 'cty', 'ltd',
];

/** Normalised key of a company name: no diacritics, no case, no punctuation, no legal form. */
function companyKey(name) {
  let s = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  for (const phrase of LEGAL_PHRASES) {
    s = (' ' + s + ' ').split(' ' + phrase + ' ').join(' ').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

function searchUrl(keyword, offset) {
  const params = new URLSearchParams({ keyword, limit: String(PAGE), offset: String(offset) });
  return `${API}?${params.toString()}`;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword ?? '').trim();
  const firstUrl = searchUrl(input, 0);
  try {
    const wanted = companyKey(input);
    if (!wanted) return fail('other', firstUrl, 'the company name is empty once the legal form is removed');

    let scanned = 0;
    let total = null;
    let offset = 0;
    let matches = [];
    let matchUrl = '';

    for (;;) {
      if (Date.now() - started > BUDGET_MS) return fail('timeout', searchUrl(input, offset), `stopped after ${scanned} results`);
      const url = searchUrl(input, offset);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return fail('blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      let body;
      try { body = await res.json(); } catch { return fail('layout_changed', url, 'the answer is not JSON'); }
      if (!body || !Array.isArray(body.shops) || typeof body.total !== 'number') {
        return fail('layout_changed', url, 'the answer has no shops list and total');
      }
      total = body.total;

      matches = body.shops.filter((shop) => companyKey(shop.name) === wanted);
      if (matches.length) { matchUrl = url; break; }   // the page holding the match is read in full

      scanned += body.shops.length;
      offset += PAGE;
      if (body.shops.length === 0 || scanned >= total) break;
      if (scanned >= MAX_SCAN) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((s) => ({
          name: s.name, id: s.id, slug: s.slug, shop_url: SHOP_PAGE + s.slug,
          address: s.address, province: s.province, city: s.city, phone: s.phone, email: s.email, website: s.website,
          status: s.status, review_status: s.review_status, business_type: s.business_type,
          main_products: s.main_products, created_at: s.created_at, updated_at: s.updated_at,
        })),
        source_url: matchUrl,
        excerpt: `Listed as "${matches[0].name}" (${matches.length} exact match${matches.length > 1 ? 'es' : ''} by name)`,
      };
    }

    if (scanned >= total || total === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `0 of ${total} results for "${input}" have this company name (${scanned} read)`,
      };
    }

    return fail('other', firstUrl, `${total} results for "${input}", ${scanned} read, no exact name match; not all read`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', firstUrl, String(err?.message || err).slice(0, 300));
  }
}
