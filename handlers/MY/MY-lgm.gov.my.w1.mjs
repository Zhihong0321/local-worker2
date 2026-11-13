export const meta = { task: 'MY-lgm.gov.my', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'registration_number', 'company_id', 'status_id', 'category', 'state', 'town', 'postcode', 'address'],
  canary: { found: 'AAMEDIX GLOVE SDN. BHD.', not_found: 'SYARIKAT FIKTIF SDN BHD' } };

// LGM MyLesen register: the public company list the MyLesen site loads anonymously (no login, no token).
const LIST_URL = 'https://api02.lgm.gov.my/Api_MyLesen/api/Companies/GetCompanies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Normalised company core: upper case, punctuation and spaces removed, trailing legal form (SDN BHD / BHD / SDN / BERHAD, optional "(M)") removed. */
function core(s) {
  let t = String(s || '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/(^| )(M )?(SDN BHD|SDN|BHD|BERHAD)$/, '').trim();
  } while (t !== prev);
  return t.replace(/ /g, '');
}

/** Fetch the company list. The LGM server is sometimes slow or drops the connection, so one retry; each try has its own 25 s limit, two tries fit in 60 s. */
async function fetchList() {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetch(LIST_URL, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source_url = LIST_URL;
  try {
    const kw = core(keyword);
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'empty company name' };

    const res = await fetchList();
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    let list;
    try {
      list = JSON.parse(body);
    } catch {
      const looksBlocked = body.trim().startsWith('<') && /captcha|challenge|cf-chl|log in|sign in/i.test(body.slice(0, 3000));
      return { status: 'couldnt_check', reason: looksBlocked ? 'blocked' : 'layout_changed', records: [], source_url, excerpt: body.slice(0, 300) };
    }
    if (!Array.isArray(list) || !list.some((r) => r && typeof r.name === 'string')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: 'the list has no company rows' };
    }

    const matches = list.filter((r) => r && typeof r.name === 'string' && core(r.name) === kw);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url,
               excerpt: `No company matching "${keyword}" in the list of ${list.length} companies` };
    }

    // Only the public register fields. Bank account, capital and ownership columns are deliberately left out.
    const records = matches.map((r) => ({
      name: String(r.name).trim().replace(/\s+/g, ' '),
      registration_number: r.registrationNumber ?? '',
      company_id: r.id ?? null,
      status_id: r.companyStatusId ?? null,
      category: r.category ?? '',
      state: r.state ?? '',
      town: r.town ?? '',
      postcode: r.postcode ?? '',
      address: [r.add1, r.add2, r.add3].map((x) => (x || '').trim()).filter(Boolean).join(', '),
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url,
      excerpt: `${records.length} match(es): ` + records.map((r) => `${r.name} (${r.registration_number})`).join('; ').slice(0, 450),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
