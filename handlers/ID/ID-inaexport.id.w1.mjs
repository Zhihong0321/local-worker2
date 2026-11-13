export const meta = {
  task: 'ID-inaexport.id',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'product_count', 'verified', 'sample_products', 'categories'],
  canary: { found: 'PT Begonia Bisnis Partner', not_found: 'PT Zzz Tidak Terdaftar Nusantara' },
};

// InaExport (SIP, sip.kemendag.go.id) public product listing. The InaExport page calls this JSON endpoint itself.
// The search parameter matches the company name, so a company is found through the products it lists.
const BASE = 'https://sip.kemendag.go.id/api/public/products';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIMIT = 100;
const LEGAL_FORMS = new Set(['pt', 'cv', 'ud', 'tbk', 'persero', 'perseroan', 'terbatas', 'firma']);

/** Lower-case, drop punctuation and legal-form words, so "PT. Begonia Bisnis Partner" equals "PT Begonia Bisnis Partner". */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join(' ');
}

function headers() {
  return { 'User-Agent': UA, 'Accept': 'application/json' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can abort (libuv assertion, exit 127) when the process exits right after a fetch body was read.
  // A short pause lets the socket close first; the answer is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  const started = Date.now();
  const urlFor = (page) => `${BASE}?page=${page}&limit=${LIMIT}&search=${encodeURIComponent(kwNorm || kw)}`;
  const firstUrl = urlFor(1);

  try {
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
    }

    const rows = [];
    for (let page = 1; page <= 2; page++) {
      // Page 2 only when page 1 was full and there is time left inside the 60 s limit.
      if (page === 2 && Date.now() - started > 25000) break;
      const url = urlFor(page);
      let res;
      try {
        res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(25000) });
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url,
          excerpt: String(e?.message || e).slice(0, 300) };
      }
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 300) };
      }
      if (!json || json.success === false || !Array.isArray(json.data)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 300) };
      }
      rows.push(...json.data);
      if (json.data.length < LIMIT) break;
    }

    // One record per company whose normalised name equals the typed name.
    const groups = new Map();
    for (const r of rows) {
      const company = typeof r?.company_name === 'string' ? r.company_name.trim() : '';
      if (!company || normalize(company) !== kwNorm) continue;
      if (!groups.has(company)) {
        groups.set(company, { name: company, product_count: 0, verified: false, sample_products: [], categories: [] });
      }
      const g = groups.get(company);
      g.product_count += 1;
      if (r.verified === true) g.verified = true;
      const product = r.product_name || r.name;
      if (product && g.sample_products.length < 5 && !g.sample_products.includes(product)) g.sample_products.push(product);
      if (r.category && g.categories.length < 5 && !g.categories.includes(r.category)) g.categories.push(r.category);
    }

    if (groups.size === 0) {
      const others = [...new Set(rows.map((r) => r.company_name).filter(Boolean))].slice(0, 5);
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `0 InaExport product listings for company "${kw}"` +
          (others.length ? `; search returned other companies: ${others.join(' | ')}` : '; search returned no products'),
      };
    }

    const records = [...groups.values()];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstUrl,
      excerpt: records.map((r) => `${r.name}: ${r.product_count} product(s), verified=${r.verified}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
