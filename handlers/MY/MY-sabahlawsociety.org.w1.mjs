export const meta = { task: 'MY-sabahlawsociety.org', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'tel', 'email', 'city'],
  canary: { found: 'ALEX PANG & CO', not_found: 'SYARIKAT GUAMAN TIADA WUJUD SDN BHD' } };

// The public page https://www.sabahlawsociety.org/find/law-firm loads its list from this JSON endpoint.
// It returns the whole directory (385 firms) in one call, with no login and no token.
const API_URL = 'https://sls2.sabahlawsociety.org/api/sls/lawfirms';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['SDN', 'BHD', 'BERHAD', 'PLT', 'LLP', 'LLC', 'LTD']);

/** Compare names: case, punctuation and trailing legal form ignored; "&" and "AND" are the same word. */
function normalizeName(str) {
  const words = String(str || '').toUpperCase().replace(/&/g, ' AND ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: API_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalizeName(keyword);
    if (!key) return couldnt('other', 'the company name has no letters or digits');

    let res;
    try {
      res = await fetch(API_URL, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return couldnt('timeout', 'no answer in 25 s');
      return couldnt('other', 'request failed: ' + String(err?.message || err));
    }

    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    let body;
    try {
      body = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return couldnt('timeout', 'body not received in time');
      return couldnt('other', 'reading the body failed: ' + String(err?.message || err));
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      if (/captcha|challenge|cf-mitigated|access denied/i.test(body)) return couldnt('blocked', 'bot check page: ' + body.slice(0, 200));
      return couldnt('layout_changed', 'not JSON: ' + body.slice(0, 200));
    }

    if (!Array.isArray(data)) return couldnt('layout_changed', 'JSON is not a list: ' + body.slice(0, 200));
    const firms = data.filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && f.name.trim());
    if (firms.length === 0) return couldnt('layout_changed', `list has ${data.length} entries, none with a name`);

    const matches = firms.filter((f) => normalizeName(f.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: API_URL,
        excerpt: `no firm in the list of ${firms.length} matches "${keyword}"`,
      };
    }

    const records = matches.map((f) => ({
      name: text(f.name),
      tel: text(f.tel),
      email: text(f.email),
      city: text(f.city),
    }));

    return {
      status: 'found', reason: '', records, source_url: API_URL,
      excerpt: `listed on the Sabah Law Society law firm directory as "${records[0].name}"`,
    };
  } catch (err) {
    return couldnt('other', String(err?.message || err));
  }
}
