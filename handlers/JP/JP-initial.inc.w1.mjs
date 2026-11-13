export const meta = {
  task: 'JP-initial.inc',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'corporate_number', 'shortname', 'established', 'english_name', 'representative', 'address', 'industry', 'record_type', 'website'],
  canary: { found: '株式会社Preferred Networks', not_found: 'ゼノネゾンアイ存在しない株式会社' },
};

const BASE = 'https://initial.inc';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en;q=0.8',
  // No keep-alive socket left open: the worker exits right after the answer, and an open socket made it abort.
  'Connection': 'close',
};

// Legal forms (Japanese and English) are dropped before comparing, so "株式会社X", "X Inc." and "X" compare equal.
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|\(株\)|\(有\)|\(同\)|(?<![a-z])(co\.?,?\s*ltd|corporation|corp|incorporated|inc|limited|ltd|llc|k\.k|kk)(?![a-z])/g;

function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LEGAL_FORMS, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function couldnt(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

// The company page holds the address, representative, etc. If it fails, the search-level fields still stand.
async function fetchDetail(path, corporateNumber) {
  try {
    const res = await fetch(BASE + path, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const company = nextData(await res.text())?.props?.pageProps?.company;
    if (!company || (company.corporateNumber && company.corporateNumber !== corporateNumber)) return null;
    return company;
  } catch {
    return null;
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
async function lookupOnce(keyword) {
  const searchUrl = `${BASE}/search?q=${encodeURIComponent(keyword)}`;
  try {
    const kw = normalize(keyword);
    if (!kw) return couldnt('other', 'empty company name after removing legal form', searchUrl);

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, searchUrl);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, searchUrl);

    const html = await res.text();
    const companies = nextData(html)?.props?.pageProps?.companies;
    if (!companies || !Array.isArray(companies.data)) {
      if (/captcha|cf-chl|Just a moment|Access Denied/i.test(html)) return couldnt('blocked', 'bot check page', searchUrl);
      return couldnt('layout_changed', html.slice(0, 300), searchUrl);
    }

    const matches = companies.data.filter((c) => normalize(c.name) === kw);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `search returned ${companies.data.length} companies, none with the same normalised name`,
      };
    }

    const details = await Promise.all(matches.map((c) => fetchDetail(c.path, c.corporateNumber)));
    const records = matches.map((c, i) => {
      const d = details[i] || {};
      return {
        name: c.name,
        corporate_number: c.corporateNumber || d.corporateNumber || '',
        shortname: c.shortname || '',
        established: c.established || String(d.establishedAt || '').slice(0, 10),
        english_name: d.englishName || '',
        representative: d.representative || '',
        address: d.address || '',
        industry: d.industry || '',
        record_type: d.recordType || '',
        website: d.website || '',
        source_url: BASE + c.path,
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} matching record(s): ${records.map((r) => r.name).join(' / ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', String(err?.message || err), searchUrl);
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // The worker exits right after it prints the answer. On Windows, Node aborts if that exit comes while a socket is
  // still closing (seen on single-request answers), so give the sockets a moment to close first.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return answer;
}
