export const meta = {
  task: 'AE-moiat.gov.ae',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_ar', 'company_id', 'count_on_site', 'certificates_returned', 'certificates'],
  canary: { found: 'Ariston S.P.A Middle East (Branch)', not_found: 'ظلال الغيوم القمرية ذ.م.م' },
};

// MoIAT Conformity Hub (conformityhub.moiat.gov.ae) reads its public certified-products data from this JSON API.
// No login: the site's own public page calls these same GET endpoints without a token.
const SITE = 'https://api.moiat.gov.ae/api/ConformityHub';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NAME_CAP = 20;        // the company search returns at most 20 names per query
const CERT_PAGE = 50;       // the site returns 50 certificate rows per page
const CERT_PAGES_MAX = 20;  // at most 1000 certificates per company
const LEGAL = new Set(['llc', 'fze', 'fzc', 'fzco', 'fz', 'sdn', 'bhd', 'ltd', 'limited', 'pvt', 'inc', 'co', 'company',
  'corp', 'corporation', 'dmcc', 'spc', 'شركه', 'ذ', 'م', 'ذم', 'ذمم']);

/** Comparable form of a company name: case, punctuation, Arabic letter variants and legal-form words removed. */
function core(s) {
  return String(s || '').normalize('NFKC').split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي'))
    .filter((t) => t && !LEGAL.has(t)).join('');
}

/** GET a list endpoint. The site answers "no rows" as a JSON empty string "" (or []), and some answers are double-encoded. */
async function getList(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  const body = text.trim();
  if (!body) return { value: [] }; // the site answers "no rows" with an empty body (checked: unlisted names)
  let v;
  try {
    v = JSON.parse(body);
  } catch {
    return /captcha|challenge|access denied/i.test(body.slice(0, 3000))
      ? { fail: 'blocked', excerpt: body.slice(0, 200) }
      : { fail: 'layout_changed', excerpt: body.slice(0, 200) };
  }
  if (typeof v === 'string') {
    const inner = v.trim();
    if (!inner) return { value: [] };
    try {
      v = JSON.parse(inner);
    } catch {
      return { fail: 'layout_changed', excerpt: inner.slice(0, 200) };
    }
  }
  if (!Array.isArray(v)) return { fail: 'layout_changed', excerpt: body.slice(0, 200) };
  return { value: v };
}

function certRow(x) {
  return {
    certificate_id: x.CertificateID,
    certificate_number: x.CertificateNumber,
    certificate_type: x.CertificateType,
    product_type: x.ProductTypeEN,
    country: x.CountryNameEN,
    status: x.StatusNameEN,
    issue_date: String(x.IssueDate || '').slice(0, 10),
    expiry_date: String(x.ExpiryDate || '').slice(0, 10),
    handler: x.HandlerName,
  };
}

const cc = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });
const failed = (r, url) => cc(r.fail, url, r.excerpt);

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let lastUrl = '';
  try {
    const want = core(keyword);
    const words = String(keyword || '').normalize('NFKC').trim().split(/\s+/)
      .map((w) => w.replace(/[,;:]+$/, '')).filter(Boolean).slice(0, 4);
    if (!want || !words.length) return cc('other', '', 'no usable company name in the input');

    // The search matches the START of the site's name. Try the longest leading part of the name first,
    // then shorter ones (the legal form may not be written the same way on the site).
    const prefixes = [...new Set(words.map((_, i) => words.slice(0, words.length - i).join(' ')))];
    let matches = [];
    let shortestComplete = false;
    for (const term of prefixes) {
      if (Date.now() - started > 40000) return cc('timeout', lastUrl, 'the search ran past 40 s');
      lastUrl = `${SITE}/GetProductLookups/?lookupType=Company&query=${encodeURIComponent(term)}`;
      const r = await getList(lastUrl);
      if (r.fail) return failed(r, lastUrl);
      matches = r.value.filter((c) => core(c.NameEN) === want || core(c.NameAR) === want);
      if (matches.length) break;
      shortestComplete = r.value.length < NAME_CAP;
    }

    if (!matches.length) {
      if (shortestComplete) {
        return {
          status: 'not_found', reason: '', records: [], source_url: lastUrl,
          excerpt: `No company named "${keyword}" in the site's company search for "${prefixes[prefixes.length - 1]}".`,
        };
      }
      return cc('other', lastUrl, `the site returns at most ${NAME_CAP} names per search and "${prefixes[prefixes.length - 1]}" reached that cap, so the name could not be narrowed`);
    }

    const records = [];
    let firstCertUrl = '';
    for (const m of matches) {
      const rows = [];
      const seen = new Set();
      for (let page = 0; page < CERT_PAGES_MAX; page++) {
        const url = `${SITE}/GetCertificatesListV3/?company=${encodeURIComponent(m.ID)}&pageIndex=${page}&pageSize=${CERT_PAGE}&getCount=false`;
        if (!firstCertUrl) firstCertUrl = url;
        const r = await getList(url);
        if (r.fail) return failed(r, url);
        const mine = r.value.filter((x) => String(x.CompanyID) === String(m.ID) && !seen.has(x.CertificateID));
        mine.forEach((x) => seen.add(x.CertificateID));
        rows.push(...mine);
        if (r.value.length === 0 || rows.length >= m.Count) break;
        if (Date.now() - started > 40000) break;
      }
      records.push({
        name: m.NameEN,
        name_ar: m.NameAR || '',
        company_id: m.ID,
        count_on_site: m.Count,
        certificates_returned: rows.length,
        certificates: rows.map(certRow),
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstCertUrl,
      excerpt: records.map((r) => `${r.name} (site ID ${r.company_id}): ${r.certificates_returned} of ${r.count_on_site} certificate(s) listed`).join('; '),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timeout ? 'timeout' : 'other', lastUrl, String((err && err.message) || err).slice(0, 300));
  }
}
