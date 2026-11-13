export const meta = {
  task: 'JP-job.rikunabi.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'encoded_id', 'industry', 'address', 'ceo_name', 'phone'],
  canary: { found: 'トヨタ自動車株式会社', not_found: '株式会社ゼノデゼネラルテスト不存在' },
};

const BASE = 'https://job.rikunabi.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8', 'Referer': `${BASE}/job_search/` };
// Graduation years the site's own search offers (27年卒..30年卒). The suggest list depends on the year.
const YEARS = ['2028', '2027', '2029', '2030'];
const LEGAL_FORM = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)/g;

/** Drop the legal form (株式会社 etc.) and surrounding spaces; used as the search keyword. */
function stripLegal(name) {
  return String(name || '').normalize('NFKC').replace(LEGAL_FORM, '').replace(/\s+/g, ' ').trim();
}

/** Compare form: no legal form, no spaces or common punctuation, lower case. */
function norm(name) {
  return stripLegal(name).toLowerCase().replace(/[\s　・･.,、。'"&\/()\-‐－]/g, '');
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

function failReason(err) {
  const n = err && err.name;
  return n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'other';
}

/** GET a URL. Returns { ok, status, text, reason?, excerpt? }. Never throws. */
async function get(url, accept) {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Accept: accept }, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { ok: false, status: res.status, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, status: res.status, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const text = await res.text();
    if (/captcha|Just a moment|cf-chl|アクセスが集中/i.test(text.slice(0, 4000))) {
      return { ok: false, status: res.status, reason: 'blocked', excerpt: 'bot or captcha page' };
    }
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, reason: failReason(err), excerpt: String(err && err.message || err).slice(0, 200) };
  }
}

function suggestUrl(keyword, year) {
  return `${BASE}/api/containers/sp/CompanySuggest/?keyword=${encodeURIComponent(keyword)}&graduationYear=${year}&suggestMode=intern&limit=50`;
}

/** One suggest call for one graduation year: list of { companyName, encodedThirdPartyId }, or a failure. */
async function suggestOne(keyword, year) {
  const url = suggestUrl(keyword, year);
  const r = await get(url, 'application/json');
  if (!r.ok) return { url, fail: r.reason, excerpt: r.excerpt };
  let j;
  try { j = JSON.parse(r.text); } catch { return { url, fail: 'layout_changed', excerpt: r.text.slice(0, 200) }; }
  if (!j || !Array.isArray(j.suggestion)) return { url, fail: 'layout_changed', excerpt: JSON.stringify(j).slice(0, 200) };
  const items = j.suggestion
    .filter((s) => s && typeof s.companyName === 'string' && /^[0-9A-Za-z_-]+$/.test(String(s.encodedThirdPartyId || '')))
    .map((s) => ({ companyName: s.companyName, encodedThirdPartyId: String(s.encodedThirdPartyId) }));
  return { url, items };
}

/** Company profile page: name, address, CEO and phone come from the embedded __NEXT_DATA__ JSON. */
async function profile(item) {
  const url = `${BASE}/company_jobs/${item.encodedThirdPartyId}/`;
  const r = await get(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
  if (!r.ok) return { url, fail: r.reason, excerpt: r.excerpt };
  const m = r.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { url, fail: 'layout_changed', excerpt: 'no __NEXT_DATA__ on company page' };
  let data;
  try { data = JSON.parse(m[1]).props.pageProps.data; } catch { return { url, fail: 'layout_changed', excerpt: 'unreadable __NEXT_DATA__' }; }
  if (!data || typeof data !== 'object') return { url, fail: 'layout_changed', excerpt: 'no page data' };
  const ov = data.companyOverview || {};
  return {
    url,
    record: {
      name: ov.companyNameDetail || data.employerName || item.companyName,
      encoded_id: item.encodedThirdPartyId,
      industry: data.industry || '',
      address: ov.address || '',
      ceo_name: ov.ceoName || '',
      phone: ov.phoneNumber || '',
    },
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const search = stripLegal(keyword);
    const target = norm(keyword);
    if (!search || !target) return couldnt('other', BASE, 'empty company name');

    // Search the site's own suggest list for each graduation year, in parallel (keeps the call under 60 s).
    const answers = await Promise.all(YEARS.map((y) => suggestOne(search, y)));
    const failed = answers.filter((a) => a.fail);

    // Candidates whose name matches after normalising (legal form, spaces, case); de-duplicated by id.
    const seen = new Map();
    for (const a of answers) {
      for (const it of a.items || []) {
        if (norm(it.companyName) === target && !seen.has(it.encodedThirdPartyId)) seen.set(it.encodedThirdPartyId, it);
      }
    }
    const matches = [...seen.values()].slice(0, 5);

    if (matches.length === 0) {
      if (failed.length) {
        // The site refused or failed for some years: we cannot say the company is absent.
        const f = failed[0];
        return couldnt(f.fail, f.url, f.excerpt);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: answers[0].url,
        excerpt: `No exact name match for "${search}" in the site's company list (graduation years ${YEARS.join(', ')}).`,
      };
    }

    // Read the profile page of each matching company, in parallel.
    const profiles = await Promise.all(matches.map((it) => profile(it)));
    const bad = profiles.find((p) => p.fail);
    if (bad) return couldnt(bad.fail, bad.url, bad.excerpt);

    const records = profiles.map((p) => p.record);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: profiles[0].url,
      excerpt: records.map((r) => `${r.name} | ${r.address} | ${r.ceo_name} | ${r.industry}`).join('\n').slice(0, 500),
    };
  } catch (err) {
    return couldnt('other', BASE, String(err && err.message || err));
  }
}
