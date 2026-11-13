export const meta = {
  task: 'KR-rra.go.kr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'app_no', 'equipment', 'model', 'countries', 'date', 'status'],
  canary: { found: '삼성전자(주)', not_found: '가나다라마바사존재안함주식회사' },
};

// RRA certification search (적합성평가 현황 검색). The site takes the firm name as EUC-KR bytes, needs a Referer
// from its search form, and is slow over long date ranges (about 2 s for one year, about 15 s for all years).
// So the name is searched one period at a time (1990-1999, then each year 2000-2026), a few periods in parallel.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_FORM = 'https://www.rra.go.kr/ko/license/A_c_search.do';
const SEARCH_VIEW = 'https://www.rra.go.kr/ko/license/A_c_search_view.do';
const PAGE_SIZE = 10;
const MAX_PAGES_PER_PERIOD = 3;        // up to 30 rows per period; more are reported as not checked
const CONCURRENCY = 8;
const NO_NEW_REQUEST_AFTER_MS = 25000; // keeps the whole call under the 60 s limit
const MAX_RECORDS = 200;
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
  'Referer': SEARCH_FORM,
};

// Each period is at most 5 years (the site's own form limit); the 1-year rule is met by the per-year periods.
function periods() {
  const out = [{ from: '19900101', to: '19941231' }, { from: '19950101', to: '19991231' }];
  for (let y = 2000; y <= 2026; y++) out.push({ from: `${y}0101`, to: `${y}1231` });
  return out;
}

const DEC = new TextDecoder('euc-kr');
let eucMap = null;

/** Percent-encodes a string as EUC-KR bytes (the site's encoding). Built from the decoder: no packages needed. */
function eucKrEncode(str) {
  if (!eucMap) {
    eucMap = new Map();
    for (let lead = 0xa1; lead <= 0xfe; lead++) {
      for (let trail = 0xa1; trail <= 0xfe; trail++) {
        const ch = DEC.decode(Uint8Array.of(lead, trail));
        if (ch && ch !== '�' && !eucMap.has(ch)) eucMap.set(ch, [lead, trail]);
      }
    }
  }
  let out = '';
  for (const ch of str) {
    if (ch.codePointAt(0) < 0x80) { out += encodeURIComponent(ch); continue; }
    const pair = eucMap.get(ch);
    out += pair ? `%${pair[0].toString(16).toUpperCase()}%${pair[1].toString(16).toUpperCase()}` : '%3F';
  }
  return out;
}

const LEGAL_RE = /^(?:\(주\)|\(유\)|\(합\)|주식회사|유한회사|합자회사|합명회사|유한책임회사)\s*|\s*(?:\(주\)|\(유\)|\(합\)|주식회사|유한회사|합자회사|합명회사|유한책임회사)$/;
const LATIN_LEGAL_RE = /(?:^|[\s,.])(?:co\.?\s*,?\s*ltd\.?|company\s*,?\s*limited|ltd\.?|inc\.?|corp\.?|corporation|llc\.?|co\.?|limited|company)\s*\.?$/i;

/** Company name without its legal form (주식회사, (주), Co., Ltd. ...), whitespace collapsed. */
function stripLegal(name) {
  let s = String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(LEGAL_RE, '').replace(LATIN_LEGAL_RE, '').trim();
    if (s === before) break;
  }
  return s;
}

/** Key for comparing company names: legal form removed, case and punctuation ignored. */
function keyOf(name) {
  return stripLegal(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** When the site cuts a long name with "...", the visible start of it. */
function truncatedPrefixKey(name) {
  const m = String(name || '').match(/^(.*?)(?:\.\.\.|…)\s*$/);
  return m ? keyOf(m[1]) : null;
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&amp;/gi, '&');
}

function cellText(td) {
  return decodeEntities(td.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Result rows of the certification table. The "no data" row has one cell, so it is skipped. */
function parseRows(html) {
  const tableAt = html.indexOf('class="table_organ0"');
  if (tableAt < 0) return null;
  const start = html.indexOf('<tbody>', tableAt);
  const end = start < 0 ? -1 : html.indexOf('</tbody>', start);
  if (start < 0 || end < 0) return null;
  const rows = [];
  for (const tr of html.slice(start, end).match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const tds = tr.match(/<td[\s\S]*?<\/td>/g) || [];
    if (tds.length < 6) continue;
    const link = tr.match(/app_no=(\d+)/);
    rows.push({
      firm: cellText(tds[0]),
      equipment: cellText(tds[1]),
      model: cellText(tds[2]),
      countries: cellText(tds[3]),
      date: cellText(tds[4]),
      status: cellText(tds[5]),
      app_no: link ? link[1] : '',
    });
  }
  return rows;
}

function pageUrl(firmEnc, period, page) {
  return `${SEARCH_VIEW}?cpage=${page}&category=&firm=${firmEnc}&fromdate=${period.from}&todate=${period.to}&sf_menucode=020104&sf_type=guckrip`;
}

async function getPage(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { err: timedOut ? 'timeout' : 'other', detail: String((e && e.message) || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { err: 'blocked', detail: `HTTP ${res.status}` };
  if (!res.ok) return { err: 'http_error', detail: `HTTP ${res.status}` };
  let html;
  try {
    html = DEC.decode(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { err: timedOut ? 'timeout' : 'other', detail: 'could not read the page body' };
  }
  const count = html.match(/인증\/등록 현황 검색결과\s*:\s*총\s*([\d,]+)\s*건/);
  if (!count) {
    if (/captcha|자동입력/i.test(html)) return { err: 'blocked', detail: 'captcha or bot check on the page' };
    return {
      err: 'layout_changed',
      detail: html.includes('정상적인 경로') ? 'site asked for the normal route (access check)' : 'no result count on the page',
    };
  }
  const rows = parseRows(html);
  if (!rows) return { err: 'layout_changed', detail: 'result table not found' };
  return { total: Number(count[1].replace(/,/g, '')), rows };
}

async function scanPeriod(firmEnc, period, kwKey, t0) {
  const st = { from: period.from, total: null, pages: 0, rows: [], err: null, detail: '', firstUrl: pageUrl(firmEnc, period, 1) };
  for (let page = 1; page <= MAX_PAGES_PER_PERIOD; page++) {
    if (page > 1) {
      if (page > Math.ceil(st.total / PAGE_SIZE)) break;          // whole period read
      if (st.rows.some((r) => keyOf(r.firm) === kwKey)) break;    // exact match in hand
    }
    if (Date.now() - t0 > NO_NEW_REQUEST_AFTER_MS) {
      st.err = 'timeout';
      st.detail = 'time limit reached before this period was fully read';
      break;
    }
    const url = pageUrl(firmEnc, period, page);
    const r = await getPage(url);
    if (r.err) { st.err = r.err; st.detail = r.detail; break; }
    st.total = r.total;
    st.pages = page;
    for (const row of r.rows) st.rows.push({ ...row, url });
  }
  st.complete = !st.err && st.total !== null && st.pages >= Math.ceil(st.total / PAGE_SIZE);
  return st;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const core = stripLegal(kw);
    const kwKey = keyOf(kw);
    if (!core || !kwKey) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_FORM, excerpt: 'no company name to search' };
    }

    const firmEnc = eucKrEncode(core);
    const queue = periods();
    const scans = [];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const period = queue.shift();
        scans.push(await scanPeriod(firmEnc, period, kwKey, t0));
      }
    }));
    scans.sort((a, b) => a.from.localeCompare(b.from));

    const seen = new Set();
    const matches = [];
    let checked = 0;
    let possible = 0;
    let totalRows = 0;
    for (const s of scans) {
      totalRows += s.total || 0;
      for (const row of s.rows) {
        checked++;
        if (keyOf(row.firm) === kwKey) {
          const id = `${row.app_no}|${row.equipment}|${row.model}|${row.date}`;
          if (!seen.has(id)) { seen.add(id); matches.push(row); }
        } else {
          const pre = truncatedPrefixKey(row.firm);
          if (pre && kwKey.startsWith(pre)) possible++;
        }
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.slice(0, MAX_RECORDS).map((r) => ({
          name: r.firm, app_no: r.app_no, equipment: r.equipment, model: r.model,
          countries: r.countries, date: r.date, status: r.status,
        })),
        source_url: matches[0].url,
        excerpt: `${matches.length} certification row(s) under this exact company name; ${checked} rows read`,
      };
    }

    const firstErr = ['blocked', 'layout_changed', 'http_error', 'timeout', 'other']
      .find((k) => scans.some((s) => s.err === k));
    if (firstErr) {
      const s = scans.find((x) => x.err === firstErr);
      return { status: 'couldnt_check', reason: firstErr, records: [], source_url: s.firstUrl, excerpt: s.detail || firstErr };
    }
    if (possible) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: scans[0].firstUrl,
        excerpt: `${possible} row(s) may be this company, but the name is cut off on the page`,
      };
    }
    const incomplete = scans.filter((s) => !s.complete);
    if (incomplete.length) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: scans[0].firstUrl,
        excerpt: `${totalRows} rows contain this name, ${checked} read; no exact name among them, the rest were not checked`,
      };
    }
    if (!HANGUL.test(stripLegal(kw))) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: scans[0].firstUrl,
        excerpt: 'the site lists companies in Korean script; a Latin-script name cannot be matched here',
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: scans[0].firstUrl,
      excerpt: `no certification row under this exact company name; all ${scans.length} periods (1990-2026) read, ${checked} rows checked`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SEARCH_FORM,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
