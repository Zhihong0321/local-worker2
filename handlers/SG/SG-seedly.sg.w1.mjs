export const meta = {
  task: 'SG-seedly.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'homepage', 'product_count', 'products', 'categories'],
  canary: { found: 'Tuas Power', not_found: 'Syarikat Tiada Rekod Sdn Bhd' },
};

const API = 'https://api.seedly.sg/api/v4/product/items';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_COMPANIES = 12;
const MAX_PAGES = 5;
const LEGAL = new Set(['pte', 'ltd', 'limited', 'sdn', 'bhd', 'berhad', 'llp', 'llc', 'inc', 'incorporated',
  'corp', 'corporation', 'co', 'company', 'pvt', 'private', 'plc']);

/** Compare key: lower case, punctuation removed, legal-form words removed, words joined. */
function nameKey(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL.has(w)).join('');
}

function result(status, reason, sourceUrl, excerpt, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '').slice(0, 500) };
}

function fetchOpts() {
  return { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(25000) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const input = String(keyword ?? '').normalize('NFKC').trim();
    const wanted = nameKey(input);
    if (!wanted) return result('couldnt_check', 'other', '', 'the name has no letters or numbers left after removing the legal form');

    // The site search takes product names, so send the name without the legal form ("PTE LTD" etc.).
    const term = input.split(/\s+/).filter((t) => nameKey(t) !== '').join(' ');
    searchUrl = `${API}?page=1&per=500&term=${encodeURIComponent(term)}`;

    // Step 1: product search. Each product carries the id of the company that owns it.
    const products = [];
    let page = 1;
    let totalPage = 1;
    do {
      const url = `${API}?page=${page}&per=500&term=${encodeURIComponent(term)}`;
      const res = await fetch(url, fetchOpts());
      if (res.status === 403 || res.status === 429) return result('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return result('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
      let body;
      try { body = await res.json(); } catch { return result('couldnt_check', 'layout_changed', url, 'not JSON'); }
      if (!body || body.code !== 'ok' || !Array.isArray(body.data)) {
        return result('couldnt_check', 'layout_changed', url, JSON.stringify(body).slice(0, 300));
      }
      products.push(...body.data);
      totalPage = Number(body?.meta?.pagination?.totalPage) || 1;
      page += 1;
    } while (page <= totalPage && page <= MAX_PAGES);
    const truncated = totalPage > MAX_PAGES;

    if (products.length === 0) {
      return result('not_found', '', searchUrl, `Seedly product search for "${term}": 0 results`);
    }

    // Group the products by company.
    const byCompany = new Map();
    for (const p of products) {
      if (typeof p.companyId !== 'number' || !p.slug || !p.categorySlug) continue;
      if (!byCompany.has(p.companyId)) byCompany.set(p.companyId, { sample: p, names: [], categories: new Set() });
      const g = byCompany.get(p.companyId);
      g.names.push(p.name);
      g.categories.add(p.categorySlug);
    }
    const ids = [...byCompany.keys()];
    const checkCompanyLimit = ids.length > MAX_COMPANIES;
    const checked = ids.slice(0, MAX_COMPANIES);

    // Step 2: one product detail per company gives the company's own name as the site writes it.
    const details = await Promise.all(checked.map(async (id) => {
      const sample = byCompany.get(id).sample;
      const url = `${API}/${encodeURIComponent(sample.slug)}?category_slug=${encodeURIComponent(sample.categorySlug)}`;
      try {
        const r = await fetch(url, fetchOpts());
        if (!r.ok) return { id, error: `HTTP ${r.status}` };
        const j = await r.json();
        const company = j?.data?.company;
        if (!company || typeof company.name !== 'string' || !company.name.trim()) return { id, error: 'no company name' };
        const homepage = (company.details?.info || []).find((i) => i.name === 'Homepage')?.value || '';
        return { id, name: company.name.trim(), homepage };
      } catch (e) {
        return { id, error: String(e?.name || e).slice(0, 100) };
      }
    }));

    const records = [];
    const failed = [];
    for (const d of details) {
      if (d.error) { failed.push(`company ${d.id}: ${d.error}`); continue; }
      if (nameKey(d.name) !== wanted) continue;
      const g = byCompany.get(d.id);
      records.push({
        name: d.name,
        company_id: d.id,
        homepage: d.homepage,
        product_count: g.names.length,
        products: g.names.slice(0, 50),
        categories: [...g.categories],
      });
    }

    if (records.length > 0) {
      const r = records[0];
      return result('found', '', searchUrl,
        `Seedly lists "${r.name}" (company ${r.company_id}) with ${r.product_count} product(s) matching "${term}"`, records);
    }
    // Could not read every company, so a miss here is not proof of absence.
    if (failed.length > 0 || checkCompanyLimit) {
      const allFailed = failed.length === checked.length;
      const why = [...failed, checkCompanyLimit ? `${ids.length - MAX_COMPANIES} more companies not read` : ''].filter(Boolean).join('; ');
      return result('couldnt_check', allFailed ? 'http_error' : 'other', searchUrl, `could not read every matching company: ${why}`);
    }
    if (truncated) {
      return result('couldnt_check', 'other', searchUrl, `search has more pages than the handler reads (${totalPage})`);
    }
    return result('not_found', '', searchUrl,
      `Seedly product search for "${term}" returned ${products.length} product(s) from ${ids.length} company(ies); none is named "${input}"`);
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return result('couldnt_check', reason, searchUrl, String(err?.message || err));
  }
}
