export const meta = { task: 'KR-fisis.fss.or.kr', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'finance_code', 'sector', 'sector_code', 'base_month'],
  canary: { found: '신한은행', not_found: '가상의테스트주식회사' } };

// FISIS (fisis.fss.or.kr) has no name search that works for companies. Its finance-company list page
// (/page/fsv302.jsp) loads one JSON list per financial sector. This handler reads the sector list, reads every
// sector's company list for its latest month, and matches the company name exactly after normalising it.

const BASE = 'https://fisis.fss.or.kr';
const PAGE = 'https://fisis.fss.or.kr/page/fsv302.jsp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BUDGET_MS = 50000;     // whole lookup stays well under the 60 s limit
const PER_CALL_MS = 25000;   // contract: every fetch gets a 25 s timeout
const CONCURRENCY = 6;       // sector calls at a time, to stay polite to the site

/** Legal forms and punctuation are dropped, so "(주)X", "㈜X", "주식회사 X", "X Co., Ltd." and "X" compare equal. */
function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(주\)|주식회사|유한회사|합자회사|합명회사|유한책임회사/g, '')
    .replace(/\bco\.?\s*,?\s*ltd\.?|\b(ltd|limited|inc|corp|corporation|company|co)\b\.?/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** One POST to a FISIS JSON endpoint. Never throws; returns { ok, dataset | reason, excerpt, url }. */
async function post(path, form, timeoutMs, datasetId) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(Math.max(1000, Math.floor(timeoutMs))),
    });
    const text = await res.text();
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json || typeof json !== 'object') {
      const looksBlocked = /captcha|access denied|forbidden|bot/i.test(text.slice(0, 2000));
      return { ok: false, reason: looksBlocked ? 'blocked' : 'layout_changed', url, excerpt: text.slice(0, 300) };
    }
    if (json.err_cd !== 0 && json.err_cd !== '0') {
      return { ok: false, reason: 'other', url, excerpt: `err_cd ${json.err_cd}: ${String(json.err_msg || '').slice(0, 200)}` };
    }
    const ds = Array.isArray(json.dataset) ? json.dataset.find((d) => d && d.id === datasetId) : null;
    if (!ds || !Array.isArray(ds.rows)) {
      return { ok: false, reason: 'layout_changed', url, excerpt: `no dataset ${datasetId}: ${text.slice(0, 200)}` };
    }
    return { ok: true, rows: ds.rows, url };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'other', url, excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Runs fn over items with at most `limit` in flight. fn must not throw. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const kwNorm = normalize(kw);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }
    const deadline = Date.now() + BUDGET_MS;
    const left = () => deadline - Date.now();

    // Step 1: the sectors on the list page, each with its latest month of data.
    const sectorsRes = await post('/fss/wa/fsv000_selectEndMonth.do', {}, Math.min(PER_CALL_MS, left()), 'gds_partDiv');
    if (!sectorsRes.ok) {
      return { status: 'couldnt_check', reason: sectorsRes.reason, records: [], source_url: sectorsRes.url, excerpt: sectorsRes.excerpt };
    }
    const sectors = sectorsRes.rows.filter((s) => s && typeof s.PART_DIV === 'string' && s.PART_DIV.length >= 2
      && /^\d{6}$/.test(String(s.LAST_TRANCE_MON || '')));
    if (sectors.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: 'no sectors with a data month' };
    }

    // Step 2: each sector's company list. The page sends the sector code without its first letter.
    const results = await mapLimit(sectors, CONCURRENCY, async (sec) => {
      if (left() < 2000) {
        return { ok: false, reason: 'timeout', url: PAGE, excerpt: 'time budget used up' };
      }
      return post('/fss/wa/fsv302_getFinanceList.do',
        { partDiv: sec.PART_DIV.slice(1), baseMonth: sec.LAST_TRANCE_MON },
        Math.min(PER_CALL_MS, left()), 'ds_financeList');
    });

    // Step 3: exact match on normalised names, company rows only (FINANCE_DIV "1"; group headers are "2").
    const records = [];
    const failures = [];
    let companyRows = 0;
    results.forEach((r, i) => {
      const sec = sectors[i];
      if (!r || !r.ok) {
        failures.push({ sector: sec.PART_NM, reason: r ? r.reason : 'other', excerpt: r ? r.excerpt : '' });
        return;
      }
      for (const row of r.rows) {
        if (!row || String(row.FINANCE_DIV) !== '1') continue;
        companyRows++;
        if (normalize(row.FINANCE_NM) === kwNorm) {
          records.push({
            name: String(row.FINANCE_NM).trim(),
            finance_code: String(row.FINANCE_CD || ''),
            sector: sec.PART_NM,
            sector_code: sec.PART_DIV,
            base_month: sec.LAST_TRANCE_MON,
          });
        }
      }
    });

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: PAGE,
        excerpt: records.map((x) => `${x.name} | ${x.sector} | code ${x.finance_code} | data to ${x.base_month}`).join('\n').slice(0, 500),
      };
    }

    // No match. Only a clean sweep of every sector counts as "not listed".
    if (failures.length > 0) {
      const reason = failures.find((f) => f.reason === 'blocked')?.reason || failures[0].reason;
      const failed = failures.slice(0, 5).map((f) => `${f.sector}: ${f.reason} (${f.excerpt})`).join('; ');
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: PAGE,
        excerpt: `${failures.length} of ${sectors.length} sectors could not be read. ${failed}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `Checked ${sectors.length} sectors, ${companyRows} company entries; no company named "${kw}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
