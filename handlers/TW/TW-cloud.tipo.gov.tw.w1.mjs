export const meta = { task: 'TW-cloud.tipo.gov.tw', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['applicant_zh', 'applicant_en', 'trademark_name', 'case_no', 'appl_no', 'status', 'appl_date', 'tmark_class', 'docid'],
  canary: { found: '鴻海精密工業股份有限公司', not_found: '零零零不存在測試股份有限公司甲乙丙丁' } };

// TIPO trademark search (cloud.tipo.gov.tw). The app's own JSON API, called anonymously:
//   POST /search/userSearch  -> { numFound, docs: [{ docid, feature_a }] }   (applicant search, exact whole name)
//   POST /result/list        -> [ { name_c_text, name_e_text, tmark_name, appl_no, ... } ]  for those docids
const API = 'https://cloud.tipo.gov.tw/S282/S282BV1/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ROWS = 300;

/** Normalised name for comparison: case, spaces, punctuation and common legal forms ignored. */
function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/股份有限公司|有限公司|公司/g, '')
    .replace(/\b(co|company|ltd|limited|inc|corp|corporation|llc|sdn|bhd|pte|plc|gmbh)\b/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { res, text };
}

function failed(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Let the sockets finish closing before the caller exits the process (Windows libuv assert otherwise).
  await new Promise((done) => setTimeout(done, 500));
  return answer;
}

async function search(keyword) {
  const searchUrl = `${API}/search/userSearch`;
  const kw = String(keyword || '').replace(/\s+/g, ' ').trim();
  if (!kw) return failed('other', searchUrl, 'empty keyword');
  try {
    // Chinese names are searched in the Chinese applicant field, Latin-script names in the English one.
    const isCjk = /[㐀-鿿豈-﫿]/.test(kw);
    const lang = isCjk ? 'cn' : 'eng';
    const field = isCjk ? 'idnamece' : 'idnamee';

    const s = await post('/search/userSearch', {
      lang,
      condition: [{ name: field, value: [kw], value2: '', oper: '1', type: 'string', logic: 'AND' }],
    });
    if (s.res.status === 403 || s.res.status === 429) return failed('blocked', searchUrl, `HTTP ${s.res.status}`);
    if (!s.res.ok) return failed('http_error', searchUrl, `HTTP ${s.res.status}`);

    let sj;
    try { sj = JSON.parse(s.text); } catch { return failed('layout_changed', searchUrl, s.text); }
    const total = Number(sj && sj.numFound);
    if (!Array.isArray(sj.docs) || !Number.isFinite(total)) return failed('layout_changed', searchUrl, s.text);

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `numFound 0 for applicant "${kw}"` };
    }

    // Fetch the rows for the hits (up to MAX_ROWS, in chunks of 100).
    const ids = sj.docs.slice(0, MAX_ROWS).map((d) => d.docid).filter(Boolean);
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const l = await post('/result/list', { lang, docs: ids.slice(i, i + 100) });
      if (l.res.status === 403 || l.res.status === 429) return failed('blocked', `${API}/result/list`, `HTTP ${l.res.status}`);
      if (!l.res.ok) return failed('http_error', `${API}/result/list`, `HTTP ${l.res.status} ${l.text}`);
      let arr;
      try { arr = JSON.parse(l.text); } catch { return failed('layout_changed', `${API}/result/list`, l.text); }
      if (!Array.isArray(arr)) return failed('layout_changed', `${API}/result/list`, l.text);
      rows.push(...arr);
    }

    // Keep only rows whose applicant name really is the company (normalised compare).
    const target = norm(kw);
    const matched = rows.filter((r) => norm(r.name_c_text) === target || norm(r.name_e_text) === target);
    if (matched.length === 0) {
      return failed('layout_changed', `${API}/result/list`, `numFound ${total} but no row carries the applicant name; ` + JSON.stringify(rows[0] || {}).slice(0, 200));
    }

    const records = matched.map((r) => ({
      applicant_zh: r.name_c_text ?? '',
      applicant_en: r.name_e_text ?? '',
      trademark_name: r.tmark_name ?? '',
      case_no: r.case_no ?? '',
      appl_no: r.appl_no ?? '',
      status: r.item_name ?? '',
      appl_date: r.appl_date ?? '',
      tmark_class: r.tmark_class_text ?? '',
      docid: r.docid ?? '',
    }));
    const note = total > MAX_ROWS ? `; only the first ${MAX_ROWS} of ${total} hits were read` : '';
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `numFound ${total}; ${matched.length} rows with applicant "${kw}"${note}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failed(timeout ? 'timeout' : 'other', searchUrl, String((err && err.message) || err));
  }
}
