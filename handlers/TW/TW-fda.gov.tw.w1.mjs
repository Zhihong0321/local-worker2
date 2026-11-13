export const meta = { task: 'TW-fda.gov.tw', want: 'w1', tier: 2, method: 'json_api', input: 'company name',
  fields: ['name', 'company_no', 'kind', 'country', 'address', 'charge', 'tel', 'ownership', 'status',
    'business_license_no', 'medical_affairs_no', 'blacklisted', 'blacklist_reason'],
  canary: { found: '天澤貿易股份有限公司', not_found: '不存在的虛構藥商股份有限公司' } };

// TFDA "許可證暨相關資料查詢" (lmspiq.fda.gov.tw) is a React page. Its company search is a public JSON POST
// with no login and no captcha. kind DR = drug companies, kind MD = medical device companies.
const ENDPOINT = 'https://lmspiq.fda.gov.tw/api/public/med/company/search';
const PAGE = 'https://lmspiq.fda.gov.tw/web/';
const KINDS = ['DR', 'MD'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LEGAL_FORMS = [
  '股份有限公司', '有限公司', '有限責任', '公司',
  'sdn bhd', 'sdn. bhd.', 'sdn.bhd.', 'pte ltd', 'pte. ltd.', 'co., ltd.', 'co.,ltd.', 'co., ltd', 'co ltd', 'co.ltd',
  'co.', 'ltd.', 'ltd', 'limited', 'inc.', 'inc', 'incorporated', 'corporation', 'corp.', 'corp', 'llc', 'l.l.c.',
  'gmbh', 's.a.', 's.l.', 'b.v.', 'plc', 'company', 'co',
];

/** Compare-only form: NFKC, lower case, 臺→台, legal form words removed, punctuation and spaces removed. */
function norm(s) {
  let t = (s || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台');
  for (const lf of LEGAL_FORMS) t = t.split(lf).join(' ');
  return t.replace(/[\s.,，。、'"`()（）\-_/&]+/g, '');
}

/** The name without its legal form, used as a broader search string (the site search is a contains match). */
function core(s) {
  let t = (s || '').normalize('NFKC').trim();
  const lower = t.toLowerCase();
  for (const lf of LEGAL_FORMS) {
    const i = lower.lastIndexOf(lf);
    if (i > 0 && i + lf.length === lower.length) { t = t.slice(0, i).trim(); break; }
  }
  return t.replace(/[.,，]+$/g, '').trim();
}

function escapeExcerpt(s) {
  return String(s || '').replace(/\s+/g, ' ').slice(0, 300);
}

async function searchOne(kind, name) {
  const body = JSON.stringify({ data: { kind, companyName: name, companyNo: '', companyId: '', isBlackList: '' } });
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
      body,
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const reason = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
    return { error: { reason, excerpt: `${kind} "${name}": ${String(e && e.message || e)}` } };
  }
  if (res.status === 403 || res.status === 429) return { error: { reason: 'blocked', excerpt: `${kind} "${name}": HTTP ${res.status}` } };
  if (!res.ok) return { error: { reason: 'http_error', excerpt: `${kind} "${name}": HTTP ${res.status}` } };

  let json;
  try { json = await res.json(); } catch { return { error: { reason: 'layout_changed', excerpt: `${kind} "${name}": reply is not JSON` } }; }
  if (!json || !Array.isArray(json.data) || !json.response || !json.response.state) {
    return { error: { reason: 'layout_changed', excerpt: `${kind} "${name}": unexpected reply shape` } };
  }
  if (json.response.state.code !== 1) {
    return { error: { reason: 'other', excerpt: `${kind} "${name}": site state ${json.response.state.code} ${json.response.state.msgSubject || ''}` } };
  }
  const total = json.page && typeof json.page.totalDatas === 'number' ? json.page.totalDatas : json.data.length;
  return { rows: json.data, truncated: total > json.data.length };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = (keyword || '').normalize('NFKC').trim();
    if (!name) return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };

    // The site matches a contains-search. Search the typed name and its core (legal form removed) in both registers.
    const queries = [...new Set([name, core(name)].filter((q) => q.length >= 2))];
    const jobs = [];
    for (const kind of KINDS) for (const q of queries) jobs.push(searchOne(kind, q));
    const answers = await Promise.all(jobs);

    const wanted = norm(name);
    const seen = new Set();
    const matches = [];
    const errors = [];
    let truncated = false;
    for (const a of answers) {
      if (a.error) { errors.push(a.error); continue; }
      if (a.truncated) truncated = true;
      for (const r of a.rows) {
        if (!r || typeof r.companyName !== 'string') continue;
        if (norm(r.companyName) !== wanted) continue;
        const key = `${r.kind}|${r.id || r.companyNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(r);
      }
    }

    if (matches.length > 0) {
      const records = matches.map((r) => ({
        name: r.companyName,
        company_no: r.companyNo || '',
        kind: r.kind || '',
        country: r.country || '',
        address: r.companyAddr || '',
        charge: r.charge || '',
        tel: r.tel || '',
        ownership: r.ownership || '',
        status: r.status || '',
        business_license_no: r.businessLicNo || '',
        medical_affairs_no: r.medicalAffairsNo || '',
        blacklisted: r.isBlackList == null ? '' : String(r.isBlackList),
        blacklist_reason: r.blackListReason || '',
      }));
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: ENDPOINT,
        excerpt: escapeExcerpt(`${first.companyName} | ${first.kind} | no. ${first.companyNo} | ${first.country} | ${first.companyAddr}`),
      };
    }

    if (errors.length > 0) {
      const order = ['blocked', 'http_error', 'timeout', 'layout_changed', 'other'];
      const worst = errors.slice().sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
      return { status: 'couldnt_check', reason: worst.reason, records: [], source_url: ENDPOINT, excerpt: escapeExcerpt(worst.excerpt) };
    }

    if (truncated) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT,
        excerpt: 'site returned more rows than it sent back; exact match not seen' };
    }

    return { status: 'not_found', reason: '', records: [], source_url: ENDPOINT,
      excerpt: `0 companies named "${name}" in the drug (DR) or medical device (MD) company search` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT,
      excerpt: escapeExcerpt(String(err && err.message || err)) };
  }
}
