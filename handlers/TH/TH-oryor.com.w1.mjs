export const meta = {
  task: 'TH-oryor.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'thai_name', 'manufacturer', 'product_name_th', 'product_name_en', 'licence_no', 'product_category', 'permit_type', 'address', 'record_id', 'new_code', 'branch'],
  canary: { found: 'บริษัท แดรี่ พลัส จำกัด', not_found: 'บริษัท ซีเอ็กซ์ยูนิคอร์นไม่มีจริง จำกัด' },
};

// The oryor.com product-check page (/check-product-serial) calls this JSON search endpoint in the browser.
// The site's own JavaScript sends the header below on every call; without it the API answers 401.
const SEARCH_BASE = 'https://api.oryor.com/productSerial/search?keyword=';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'X-Authorization': 'keeneye',
};

/** Legal form words removed, lower case, no spaces or punctuation. Thai and Latin letters and digits are kept. */
function coreOf(name) {
  let s = String(name || '').normalize('NFC').toLowerCase();
  s = s.replace(/\(\s*มหาชน\s*\)|มหาชน|\bpublic\s+company\s+limited\b|\bco\.?\s*,?\s*ltd\.?|\blimited\b|\bltd\.?|\binc\.?/g, ' ');
  s = s.replace(/ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|หจก\.?|บจก\.?|บมจ\.?|บริษัทฯ|บริษัท|จำกัด/g, ' ');
  return s.replace(/[^a-z0-9฀-๿]+/g, '');
}

function clean(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = coreOf(keyword);
    const searchUrl = SEARCH_BASE + encodeURIComponent(want);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
               excerpt: 'no company name left after removing the legal form' };
    }

    let res;
    try {
      res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: searchUrl,
               excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    if (!Array.isArray(rows)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    if (rows.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
               excerpt: `Search returned 0 product records for "${want}"` };
    }
    if (!rows.some((r) => r && typeof r === 'object' && 'licen' in r)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    // The search matches product text too, so keep only rows whose holder, Thai name or manufacturer is this company
    // (exact after normalising, or a branch of it: "<name> สาขา ...").
    const matched = rows.filter((r) =>
      r && typeof r === 'object' &&
      [r.licen, r.thanm, r.cncnm].some((v) => {
        const c = coreOf(v);
        return c === want || c.startsWith(want + 'สาขา');
      }));

    if (matched.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
               excerpt: `Search returned ${rows.length} product records, none with a holder or manufacturer named "${keyword}"` };
    }

    const records = matched.map((r) => {
      const holder = clean(r.licen);
      return {
        name: holder,
        thai_name: clean(r.thanm),
        manufacturer: clean(r.cncnm),
        product_name_th: clean(r.productha),
        product_name_en: clean(r.produceng),
        licence_no: clean(r.lcnno),
        product_category: clean(r.typepro),
        permit_type: clean(r.typeallow),
        address: clean(r.Addr),
        record_id: clean(String(r.IDA ?? '')),
        new_code: clean(r.NewCode),
        branch: coreOf(holder) !== want,
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${matched.length} of ${rows.length} product records have "${keyword}" as holder, Thai name or manufacturer`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SEARCH_BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
