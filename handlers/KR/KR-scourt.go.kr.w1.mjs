export const meta = {
  task: 'KR-scourt.go.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'court_code', 'case_no', 'case_no_display', 'division', 'task', 'notice_title', 'notice_date'],
  canary: { found: '주식회사 투니모션', not_found: '주식회사 가나다라마바사' },
};

// Same POST the public insolvency page's embedded list screen (SSGO931M02) sends for a 채무자명 (debtor name) search.
const ENDPOINT = 'https://ssgo.scourt.go.kr/ssgo/ssgo930/selectRhblBnkpPbancLst.on';
const PUBLIC_PAGE = 'https://www.scourt.go.kr/portal/notice/insolvency/insolvency.jsp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 법인회생 (corporate rehabilitation) and 법인파산 (corporate bankruptcy) notice lists.
const TASKS = [
  { code: '4', label: '법인회생' },
  { code: '5', label: '법인파산' },
];
// Court codes from the page's own court table (the 회생·지방법원 list). The search returns nothing without a court code.
const COURTS = ['000221', '000214', '000240', '000260', '000261', '000249', '000291', '000270',
  '000520', '000420', '000321', '000543', '000443', '000411', '000530'];

/** Run fn over items with at most `limit` in flight. A thrown error becomes a couldnt_check outcome, never a crash. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch((err) => ({ ok: false, reason: 'other', excerpt: String(err?.message || err).slice(0, 200) }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const LEGAL_FORM = /주식회사|유한회사|합자회사|합명회사|유한책임회사|농업회사법인|영농조합법인|사단법인|재단법인|학교법인|의료법인|법인|\(주\)|\(유\)|\(합\)|\(사\)|\(재\)|㈜|㈔|㈜/g;

/** Compare names: NFKC, lower case, legal form and every space or punctuation mark removed. */
function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(LEGAL_FORM, '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function fmtDate(ymd) {
  const s = String(ymd || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/** One POST to the site's own list search for one task type. Returns { ok, rows } or { ok: false, reason, excerpt }. */
async function searchTask(taskCode, courtCode, debtorQuery) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'user-agent': UA,
        'content-type': 'application/json; charset=UTF-8',
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'referer': 'https://ssgo.scourt.go.kr/ssgo/ui/ssgo900/ssgo930/SSGO931M02.xml',
      },
      body: JSON.stringify({
        dma_search: {
          taskDvs: taskCode, srchType: 'debtrNm', cortCd: courtCode, pstgDvs: '999',
          csYr: '', csDvsCd: '', csSrno: '', csNo: '', debtrNm: debtorQuery, jdbnCd: '',
        },
        dma_pageInfo: { pageNo: '1', pageSize: '1000', totalYn: 'Y' },
      }),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json) {
    const blocked = /captcha|보안문자|자동입력|접근이\s*제한/i.test(text);
    return { ok: false, reason: blocked ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 200) };
  }
  const list = json?.data?.dlt_pbancLst;
  if (!Array.isArray(list)) {
    return { ok: false, reason: 'layout_changed', excerpt: `no data.dlt_pbancLst; message: ${String(json?.message || '').slice(0, 120)}` };
  }
  return { ok: true, rows: list };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = PUBLIC_PAGE;
  try {
    const typed = String(keyword || '').trim();
    const core = normalize(typed);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'no company name in the input' };
    }

    // The site matches the debtor name only when typed without spaces ("주식회사투니모션" finds "주식회사 투니모션").
    // A name typed without a legal form is also tried with 주식회사 in front.
    const queries = [typed.replace(/\s+/g, '')];
    if (!/주식회사|\(주\)|㈜|유한|합자|합명|법인/.test(typed)) queries.push('주식회사' + typed.replace(/\s+/g, ''));

    const jobs = [];
    for (const t of TASKS) for (const c of COURTS) for (const q of queries) jobs.push({ task: t, court: c, q });
    const outcomes = await pool(jobs, 6, (j) => searchTask(j.task.code, j.court, j.q));

    const failures = outcomes.filter((o) => !o.ok);
    const records = [];
    const seen = new Set();
    outcomes.forEach((o, i) => {
      if (!o.ok) return;
      for (const row of o.rows) {
        if (normalize(row.btprtNm) !== core) continue;
        const key = [row.cortCd, row.csNo, row.pbancBgngYmd, row.pbancTitlNm, row.inetPbancSeq].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          name: row.btprtNm,
          court_code: row.cortCd,
          case_no: row.csNo,
          case_no_display: row.csNoNm,
          division: row.jdbnCdNm,
          task: jobs[i].task.label,
          notice_title: row.pbancTitlNm,
          notice_date: fmtDate(row.pbancBgngYmd),
        });
      }
    });

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: `${records.length} notice(s) for "${records[0].name}" on the site's 법인회생/법인파산 list: ${records.map((r) => r.case_no_display).join(', ')}`.slice(0, 500),
      };
    }

    // Nothing matched. Only a clean answer from every search counts as not_found: a refused or failed search never does.
    if (failures.length > 0) {
      const f = failures[0];
      return { status: 'couldnt_check', reason: f.reason, records: [], source_url: sourceUrl, excerpt: f.excerpt };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `0 matching notices for "${typed}" in the 법인회생 and 법인파산 lists of ${COURTS.length} courts (the site shows only notices still in their posting period)`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
