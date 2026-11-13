export const meta = { task: 'ID-fintech.id', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'platform', 'membership_start_date', 'updated_at', 'member_page'],
  canary: { found: 'PT Bimasakti Multi Sinergi', not_found: 'PT Sumber Rezeki Tanpa Nama Abadi' } };

// The AFTECH member directory (https://fintech.id/id/community/aftech-members) is rendered by the browser from this
// public JSON API. The search box sends filter[query]; the directory shows only active members (filter[isActiveMember]).
const API = 'https://api.fintech.id/api/v1/companies';
const SITE = 'https://fintech.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pt', 'cv', 'tbk', 'persero', 'perseroan', 'terbatas', 'ud', 'firma', 'koperasi']);

/** Lower-case words of a name: accents, case and punctuation removed. */
function words(str) {
  return (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** The name without its legal form (PT, CV, Tbk, ...) at either end, as one comparable string. */
function coreName(str) {
  const w = words(str);
  while (w.length && LEGAL_FORMS.has(w[0])) w.shift();
  while (w.length && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const core = coreName(keyword);
  const searchUrl = `${API}?${new URLSearchParams({ limit: '100', offset: '0', 'filter[isActiveMember]': 'true', 'filter[query]': core })}`;
  try {
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'no company name in the keyword' };
    }

    let res;
    try {
      res = await fetch(searchUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(25000) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json || !Array.isArray(json.data) || !Number.isFinite(json.totalData)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    // The site search also matches other fields (e.g. the platform brand), so keep only the exact company name.
    const matches = json.data.filter((r) => coreName(r.name) === core && core !== '');
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.name || '',
          platform: r.platform || '',
          membership_start_date: r.membershipStartDate || '',
          updated_at: r.updatedAt || '',
          member_page: r._id ? `${SITE}/id/community/aftech-members/${r._id}` : '',
        })),
        source_url: searchUrl,
        excerpt: `${matches[0].name} is an active AFTECH member (${json.totalData} result(s) for "${core}")`,
      };
    }

    // Not all results were read: an exact match could be on a page we did not fetch, so do not say "not found".
    if (json.data.length < json.totalData) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: `${json.totalData} results, only ${json.data.length} read` };
    }

    const similar = json.data.slice(0, 5).map((r) => r.name).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `0 active members named "${keyword}"${similar ? ` (similar names only: ${similar})` : ''}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
