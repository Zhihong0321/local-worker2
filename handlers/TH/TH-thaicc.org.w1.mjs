export const meta = { task: 'TH-thaicc.org', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'name_th', 'name_cn', 'location_en', 'location_th', 'phone', 'website'],
  canary: { found: 'K.C. SALT INTERNATIONAL CO., LTD.', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' } };

// thaicc.org is a React app. Its member directory is loaded from a JSON endpoint (one row per member contact,
// with company_en / company_th / company_cn). The endpoint's own `name` filter only matches English names, so a
// Thai query would wrongly come back empty. This handler fetches the whole list once and matches locally.
const API = 'https://thaicc.org/api/ApiArea/Company/search?text=&name=NA&category_id=NA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_EN = new Set(['co', 'ltd', 'limited', 'company', 'corp', 'corporation', 'inc', 'plc', 'pcl', 'public', 'part', 'partnership']);

/** Normalised core of a company name: case, punctuation, spaces and legal form removed. */
function core(raw) {
  let s = String(raw || '').normalize('NFKC').toLowerCase();
  s = s.replace(/\(มหาชน\)|มหาชน|บริษัท|จำกัด|ห้างหุ้นส่วน|股份有限公司|有限公司/g, ' ');
  return s.split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t && !LEGAL_EN.has(t)).join('');
}

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = core(keyword);
    if (!target) return fail('other', API, 'empty company name');

    const res = await fetch(API, {
      headers: { 'user-agent': UA, 'accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', API, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', API, `HTTP ${res.status}`);

    const text = await res.text();
    let rows;
    try { rows = JSON.parse(text); } catch { return fail('layout_changed', API, text.slice(0, 200)); }
    if (!Array.isArray(rows) || rows.length === 0 || !rows.some((r) => r && 'company_en' in r)) {
      return fail('layout_changed', API, 'member list is not in the expected shape');
    }

    const hits = new Map();
    for (const r of rows) {
      const names = [r.company_en, r.company_th, r.company_cn]
        .flatMap((v) => String(v || '').split('/'))
        .map(core)
        .filter(Boolean);
      if (!names.includes(target)) continue;
      const key = `${clean(r.company_en)}|${clean(r.company_th)}`;
      if (!hits.has(key)) {
        hits.set(key, {
          name: clean(r.company_en),
          name_th: clean(r.company_th),
          name_cn: clean(r.company_cn),
          location_en: clean(r.location_en),
          location_th: clean(r.location_th),
          phone: clean(r.phone_company),
          website: clean(r.website),
        });
      }
    }

    if (hits.size === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: API,
        excerpt: `member list of ${rows.length} rows: no company matches "${clean(keyword)}"` };
    }
    const records = [...hits.values()];
    return { status: 'found', reason: '', records, source_url: API,
      excerpt: `${records[0].name} | ${records[0].name_th} | ${records[0].location_en}`.slice(0, 300) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', API, String(err?.message || err));
  }
}
