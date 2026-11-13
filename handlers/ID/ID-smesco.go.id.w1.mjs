export const meta = {
  task: 'ID-smesco.go.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'business_name', 'business_type', 'verification_status', 'is_verified', 'registered_on', 'uuid', 'nib', 'start_date', 'address'],
  canary: { found: 'PT Rempah Sumber Rezeki', not_found: 'CV Tidak Terdaftar Xyzzq Nusantara' },
};

// SMESCO's UMKM catalogue (katalog.smesco.go.id) reads its listings from this public JSON API.
// The search and profile calls need no login and no key.
const API = 'https://katalogapi.smesco.go.id/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };
const PER_PAGE = 100;      // the API's maximum page size
const MAX_PAGES = 5;       // 500 keyword hits at most; beyond that we say so
const SEARCH_BUDGET_MS = 30000;  // do not start another search page after 30 s
const OPTIONAL_BUDGET_MS = 25000; // do not start a profile call after 25 s
const MAX_DETAILS = 5;

// Indonesian legal forms, dropped before comparing names ("PT. Rempah" == "PT Rempah" == "Rempah").
const LEGAL_FORMS = new Set(['pt', 'cv', 'ud', 'tbk', 'persero', 'perseroan', 'terbatas', 'firma', 'fa', 'pd']);

/** Lower-case words of a name, legal form removed, joined with single spaces. */
function coreWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

function sameCompany(a, b) {
  const x = coreWords(a);
  return x !== '' && x === coreWords(b);
}

function asText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

async function getJson(url, budgetMs) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(budgetMs) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', excerpt: `HTTP ${res.status}` } };
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const low = text.slice(0, 2000).toLowerCase();
    const walled = /captcha|challenge|cf-browser|access denied/.test(low);
    return {
      fail: {
        status: 'couldnt_check',
        reason: walled ? 'blocked' : 'layout_changed',
        excerpt: text.slice(0, 200),
      },
    };
  }
  return { body };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows with Node 24 the process can exit while the last keep-alive socket is still closing,
  // and the runner then aborts (exit 127) and loses the answer. A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const core = coreWords(keyword);
  const searchUrl = `${API}/umkm/search?keyword=${encodeURIComponent(core)}&per_page=${PER_PAGE}`;

  try {
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
               excerpt: 'the name has no words left to search for after removing the legal form' };
    }

    // Step 1: search. Keep every listing whose legal name (or shop name) is the same company.
    const matches = [];
    let scanned = 0;
    let lastPageFull = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > SEARCH_BUDGET_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl,
                 excerpt: `search still running after ${SEARCH_BUDGET_MS / 1000} s (page ${page})` };
      }
      const url = `${searchUrl}&page=${page}`;
      const got = await getJson(url, 25000);
      if (got.fail) return { ...got.fail, records: [], source_url: url };

      const rows = got.body?.data?.data;
      if (!Array.isArray(rows)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
                 excerpt: JSON.stringify(got.body).slice(0, 200) };
      }
      scanned += rows.length;
      for (const row of rows) {
        if (sameCompany(row.business_name, keyword) || sameCompany(row.shop_name, keyword)) matches.push(row);
      }
      lastPageFull = rows.length >= PER_PAGE;
      if (!lastPageFull) break;
    }
    // The page count in "meta" is not reliable on this API, so a full last page is the only signal.
    if (lastPageFull) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
               excerpt: `more than ${MAX_PAGES * PER_PAGE} listings match "${core}"; not all were read` };
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `search for "${core}" returned ${scanned} listing(s); none has this company name`,
      };
    }

    // Step 2: profile of each match (registration number, start date). Optional: a failure keeps the match.
    const records = [];
    for (let i = 0; i < matches.length; i++) {
      const row = matches[i];
      const rec = {
        name: asText(row.shop_name),
        business_name: asText(row.business_name),
        business_type: asText(row.business_type),
        verification_status: asText(row.verification_status_label || row.verification_status),
        is_verified: row.is_verified === true,
        registered_on: asText(row.created_at),
        uuid: asText(row.uuid),
        nib: '',
        start_date: '',
        address: '',
      };
      if (i < MAX_DETAILS && row.uuid && Date.now() - started < OPTIONAL_BUDGET_MS) {
        const detailUrl = `${API}/umkm/${encodeURIComponent(row.uuid)}`;
        try {
          const got = await getJson(detailUrl, 25000);
          const d = got.body?.data;
          if (d) {
            rec.nib = asText(d.nib_formatted || d.nib);
            rec.start_date = asText(d.business_info?.start_date);
            rec.address = asText(d.address);
          }
        } catch {
          // keep the search fields
        }
      }
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${first.business_name} (shop: ${first.name}), ${first.business_type}, ${first.verification_status}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
