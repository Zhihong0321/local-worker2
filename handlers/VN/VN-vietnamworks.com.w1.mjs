export const meta = {
  task: 'VN-vietnamworks.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_ccp', 'company_id', 'company_slug', 'website', 'address', 'company_size', 'online_job_count', 'profile_url'],
  canary: { found: 'Ngân Hàng TMCP Việt Nam Thịnh Vượng VPbank', not_found: 'Bấtồnhoamộngthiênlạc' },
};

// Public company search used by the VietnamWorks company list page (anonymous, no login, no token).
const API = 'https://ms.vietnamworks.com/company-profile/v1.0/company/search';
const SITE = 'https://www.vietnamworks.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HITS = 100;

// Legal-form words removed before two names are compared (after lower-casing and dropping diacritics).
const LEGAL = [
  'cong ty trach nhiem huu han mot thanh vien', 'cong ty trach nhiem huu han', 'cong ty co phan', 'cong ty tnhh',
  'cong ty', 'tnhh mtv', 'tnhh', 'mtv', 'tmcp', 'co phan', 'pte ltd', 'sdn bhd', 'co ltd', 'jsc', 'ltd',
  'limited', 'company', 'corporation', 'corp', 'inc', 'llc', 'co', 'cp',
];

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Comparable form of a company name: no diacritics, no punctuation, no legal form, no spaces. */
function core(s) {
  let t = ' ' + fold(s) + ' ';
  for (const phrase of LEGAL) t = t.replace(new RegExp(' ' + phrase + ' ', 'g'), ' ');
  return t.replace(/\s+/g, '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const wanted = core(kw);
  if (!wanted) return fail('other', API, 'no usable company name after removing the legal form');

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: kw, order: [], facets: [], hitsPerPage: HITS, filter: [], page: 0, userId: 0, isJobs: true }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('blocked', API, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', API, `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|cf-chl|challenge-platform|access denied/i.test(text)) return fail('blocked', API, text.slice(0, 200));

    let json;
    try { json = JSON.parse(text); } catch { return fail('layout_changed', API, text.slice(0, 200)); }
    if (!json || json.meta?.code !== 200 || !Array.isArray(json.data)) {
      return fail('layout_changed', API, JSON.stringify(json?.meta ?? json).slice(0, 200));
    }

    const nbHits = Number(json.meta.nbHits) || 0;
    const scanned = json.data.length;
    const matches = json.data.filter((c) => core(c.companyName) === wanted || (c.companyNameCCP && core(c.companyNameCCP) === wanted));

    if (matches.length === 0) {
      if (nbHits > scanned) {
        // The site has more hits than this check read, so an exact match could be further down.
        return fail('other', API + ' (query: ' + kw + ')', `${nbHits} hits, only the first ${scanned} read, no exact name match`);
      }
      const closest = json.data.slice(0, 3).map((c) => c.companyName).join(' | ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: API + ' (query: ' + kw + ')',
        excerpt: `0 exact name matches for "${kw}" in ${nbHits} search hits; first hits: ${closest}`.slice(0, 300),
      };
    }

    const records = matches.map((c) => ({
      name: c.companyName,
      name_ccp: c.companyNameCCP || "",
      company_id: c.companyId,
      company_slug: c.companySlug || '',
      website: c.website || '',
      address: c.address || '',
      company_size: c.companySizeName || '',
      online_job_count: c.onlineJobCount ?? null,
      profile_url: c.companySlug ? `${SITE}/company/${c.companySlug}` : '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url || API,
      excerpt: `${records[0].name} | ${records[0].address} | ${records[0].company_size}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', API, err?.message || err);
  }
}
