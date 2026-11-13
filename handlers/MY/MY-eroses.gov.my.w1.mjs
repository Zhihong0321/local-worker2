export const meta = {
  task: 'MY-eroses.gov.my',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'society_no', 'application_no', 'status_code', 'application_status_code', 'category_code', 'sub_category_code'],
  canary: { found: 'PERSATUAN KEBUDAYAAN DAN KESENIAN WING CHUN SKL', not_found: 'PERSATUAN ZXQWVTIDAKWUJUD KUALA' },
};

// The public "Carian" page of eROSES calls this endpoint without any login (no auth headers are sent).
const BASE = 'https://a-erosesv2.ros.gov.my';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 6;
const FETCH_MS = 25000;
const STOP_AFTER_MS = 40000; // do not start another page after this, so the whole call ends well under 60 s
const LEGAL_TOKENS = new Set(['SDN', 'BHD', 'BERHAD']);

/** Compare-form of a name: case, punctuation, "&" = DAN, company legal form words removed, Unicode kept. */
function normalize(str) {
  return String(str || '')
    .toUpperCase()
    .replace(/&/g, ' DAN ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_TOKENS.has(t))
    .join(' ');
}

function searchUrl(keyword, pageNo) {
  return `${BASE}/society/searchByNameByPublic?pageSize=${PAGE_SIZE}&pageNo=${pageNo}&societyName=${encodeURIComponent(keyword)}`;
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const firstUrl = searchUrl(name, 1);
  try {
    const wanted = normalize(name);
    if (!wanted) return fail('couldnt_check', 'other', firstUrl, 'empty company name');

    const rows = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > STOP_AFTER_MS) {
        return fail('couldnt_check', 'timeout', searchUrl(name, page), `stopped after ${rows.length} of ${total} rows to stay under 60 s`);
      }
      const url = searchUrl(name, page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return fail('couldnt_check', 'layout_changed', url, text.slice(0, 300));
      }

      // The site answers "no societies found" as HTTP 200 with code 404 and data null: a normal empty result.
      if (body && body.code === 404) {
        if (page === 1) {
          return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: String(body.status || 'No societies found with the given name.') };
        }
        break;
      }
      const d = body && body.data;
      if (!body || body.code !== 200 || !d || !Array.isArray(d.data) || typeof d.total !== 'number') {
        return fail('couldnt_check', 'layout_changed', url, text.slice(0, 300));
      }

      total = d.total;
      rows.push(...d.data);
      if (d.data.length === 0 || rows.length >= total) break;
    }

    const matches = rows.filter((r) => normalize(r.societyName) === wanted);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.societyName,
          society_no: r.societyNo,
          application_no: r.applicationNo,
          status_code: r.statusCode,
          application_status_code: r.applicationStatusCode,
          category_code: r.categoryCodeJppm,
          sub_category_code: r.subCategoryCode,
        })),
        source_url: firstUrl,
        excerpt: matches.map((r) => `${r.societyName} | society no ${r.societyNo} | status code ${r.statusCode}`).join(' ; ').slice(0, 500),
      };
    }

    if (rows.length < total) {
      return fail('couldnt_check', 'other', firstUrl, `search has ${total} partial matches, only ${rows.length} checked, no exact name among them`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `${total} partial match(es) listed, none with this exact name`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timedOut ? 'timeout' : 'other', firstUrl, String((err && err.message) || err));
  }
}
