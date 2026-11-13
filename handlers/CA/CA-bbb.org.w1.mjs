export const meta = {
  task: 'CA-bbb.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'city', 'province', 'postalcode', 'phone', 'bbb_office', 'rating', 'accreditation_status', 'out_of_business', 'categories', 'business_id', 'profile_url'],
  canary: { found: 'Canadian Tire Corporation, Limited', not_found: 'Réseau Zqxvk Fantome Inc.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms (English and French), compared after accents and case are removed.
const LEGAL = new Set(['incorporated', 'inc', 'limited', 'ltd', 'corporation', 'corp', 'company', 'co', 'llc', 'lp', 'ltee', 'limitee', 'enr', 'sa', 'sas', 'srl']);

function cleanText(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, '')       // search highlight tags such as <em>
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normName(str) {
  return cleanText(str)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/#\s*\d+/g, ' ')      // branch numbers, e.g. "Tim Hortons #533"
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = `https://www.bbb.org/api/search?find_text=${encodeURIComponent(kw)}&find_country=CAN`;
  const fail = (status, reason, excerpt) => ({ status, reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300) });

  try {
    const kwNorm = normName(kw);
    if (!kwNorm) return fail('couldnt_check', 'other', 'the name has no letters or numbers to search for');

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.text();

    if (res.status === 403 || res.status === 429 || res.headers.get('cf-mitigated') === 'challenge' || /Just a moment/i.test(body.slice(0, 2000))) {
      return fail('couldnt_check', 'blocked', `HTTP ${res.status}: bot check page`);
    }
    if (!res.ok) return fail('couldnt_check', 'http_error', `HTTP ${res.status}`);

    let data;
    try { data = JSON.parse(body); } catch { return fail('couldnt_check', 'layout_changed', body.slice(0, 300)); }
    if (!data || !Array.isArray(data.results) || typeof data.totalResults !== 'number') {
      return fail('couldnt_check', 'layout_changed', body.slice(0, 300));
    }

    const results = data.results;
    const firstPageOnly = data.totalResults > results.length;
    const hits = results.filter((r) => normName(r.businessName) === kwNorm);

    if (hits.length === 0) {
      if (firstPageOnly) {
        return fail('couldnt_check', 'other', `no exact match on the first page; ${data.totalResults} results in total, later pages not read`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 exact name matches among ${data.totalResults} BBB Canada results for "${kw}"` };
    }

    const first = cleanText(hits[0].businessName);
    return {
      status: 'found',
      reason: '',
      records: hits.map((r) => ({
        name: cleanText(r.businessName),
        address: r.address || '',
        city: r.city || '',
        province: r.state || '',
        postalcode: r.postalcode || '',
        phone: Array.isArray(r.phone) ? r.phone.join(', ') : '',
        bbb_office: r.bbbName || '',
        rating: r.rating || '',
        accreditation_status: r.accreditationStatus || '',
        out_of_business: r.outOfBusinessStatus || '',
        categories: Array.isArray(r.categories) ? r.categories.map((c) => c.name).join(', ') : '',
        business_id: r.businessId || '',
        profile_url: r.reportUrl ? `https://www.bbb.org${r.reportUrl}` : '',
      })),
      source_url: searchUrl,
      excerpt: `${hits.length} BBB Canada listing(s) match "${first}" (${data.totalResults} results for "${kw}"${firstPageOnly ? ', first page only' : ''})`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timedOut ? 'timeout' : 'other', String(err?.message || err));
  }
}
