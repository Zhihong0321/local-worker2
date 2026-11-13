// BSMI (civil.bsmi.gov.tw) lookup: 型式認可證書查詢 (type approval / RPC certificate query).
// The page calls a JSON POST endpoint; the server does a substring match on the applicant name (申請人).
// The endpoint returns at most 10000 rows per query, so a broad name is checked for truncation.

export const meta = { task: 'TW-civil.bsmi.gov.tw', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'certificate_no', 'product_name', 'model', 'status', 'validity_roc', 'list_id'],
  canary: { found: '虹光精密工業股份有限公司', not_found: '測試不存在股份有限公司甲乙丙丁' } };

const API = 'https://civil.bsmi.gov.tw/bsmi_pqn/API/UQI2105List.action';
const PAGE = 'https://civil.bsmi.gov.tw/uqi2105f';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROW_CAP = 10000;

const EN_LEGAL = new Set(['sdn', 'bhd', 'pte', 'pty', 'ltd', 'limited', 'co', 'inc', 'corp', 'corporation', 'company', 'gmbh', 'llc', 'plc']);
const CJK_LEGAL = ['股份有限公司', '有限公司', '股份有限', '公司'];

/** Remove a trailing legal form (Chinese or English), keep the rest as typed. */
function legalStrip(str) {
  let s = String(str ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const words = s.split(' ');
  while (words.length > 1 && EN_LEGAL.has(words[words.length - 1].replace(/[^a-z]/gi, '').toLowerCase())) words.pop();
  s = words.join(' ');
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of CJK_LEGAL) {
      if (s.endsWith(t) && s.length > t.length) { s = s.slice(0, -t.length).trim(); changed = true; }
    }
  }
  return s;
}

/** Comparison key: legal form, case, spaces and punctuation ignored. */
function matchKey(str) {
  return legalStrip(str).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Cut text to n characters for the excerpt. */
function short(s, n) { return String(s ?? '').slice(0, n); }

function isTimeout(e) { return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError'); }

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: short(excerpt, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node 24 on Windows can abort (exit 127) when the process exits right after a keep-alive
  // socket was used. A short pause lets the socket settle before the runner exits. Nothing is lost.
  await new Promise((r) => setTimeout(r, 500));
  return answer;
}

async function search(keyword) {
  try {
    const sent = String(keyword ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const query = legalStrip(sent);
    const want = matchKey(sent);
    if (!query || !want) return fail('other', PAGE, 'no company name left after removing the legal form');

    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ q_applName: query }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      if (isTimeout(e)) return fail('timeout', API, 'no answer in 25 s');
      return fail('other', API, 'fetch failed: ' + String(e?.message || e));
    }

    if (res.status === 403 || res.status === 429) return fail('blocked', API, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', API, `HTTP ${res.status}`);

    let text;
    try { text = await res.text(); } catch (e) {
      if (isTimeout(e)) return fail('timeout', API, 'answer not complete in 25 s');
      return fail('other', API, 'reading the answer failed: ' + String(e?.message || e));
    }
    let j;
    try { j = JSON.parse(text); } catch {
      if (/captcha|驗證碼|access denied|forbidden/i.test(text)) return fail('blocked', API, text.slice(0, 200));
      return fail('layout_changed', API, 'answer is not JSON: ' + text.slice(0, 200));
    }

    if (j && Array.isArray(j.data)) {
      const rows = j.data;
      const matches = rows.filter((r) => r && matchKey(r.L2) === want);
      const shown = `query "${query}" returned ${rows.length} rows`;
      if (matches.length > 0) {
        const records = matches.map((r) => ({
          name: r.L2,
          certificate_no: r.L1,
          product_name: r.L3,
          model: r.L4,
          status: r.L5,
          validity_roc: r.L6,
          list_id: r.L0,
        }));
        return {
          status: 'found', reason: '', records, source_url: PAGE,
          excerpt: short(`${records.length} certificate(s) for ${records[0].name}; ${shown}`, 300),
        };
      }
      if (rows.length >= ROW_CAP) {
        return fail('other', PAGE, `${shown}: the site caps results at ${ROW_CAP}, no exact name among them`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: short(`0 exact applicant matches; ${shown}`, 300) };
    }

    // The site answers data:null for a query with no rows; it echoes the name it searched for.
    if (j && j.data === null && j.q_applName === query) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: short(`site returned no rows for "${query}"`, 300) };
    }

    return fail('layout_changed', API, 'unexpected answer: ' + text.slice(0, 200));
  } catch (err) {
    return fail('other', PAGE, String(err?.message || err));
  }
}
