export const meta = {
  task: 'VN-vieclamtot.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ads_matched', 'ad_ids', 'areas', 'category'],
  canary: { found: 'Công ty Cổ phần Dịch vụ Giao Hàng Nhanh', not_found: 'Công ty TNHH Mặt Trăng Xanh Không Tồn Tại' },
};

// Public JSON search behind vieclamtot.com's job ads. Each ad carries the employer name as the poster typed it
// (company_name). The handler searches the ads for the company's words and keeps only ads whose company_name
// matches the input after removing case, accents, punctuation and the legal form.

const API = 'https://gateway.chotot.com/v1/public/ad-listing';
const PAGE = 50;          // the API returns at most 50 ads per call
const MAX_PAGES = 8;      // at most 400 search results read per lookup
const BUDGET_MS = 45000;  // stop starting new pages after 45 s (the whole call must end under 60 s)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const JOB_CATEGORY = 'viec lam';

const LEGAL_PHRASES = ['mot thanh vien', 'trach nhiem huu han', 'doanh nghiep tu nhan', 'cong ty', 'co phan',
  'tnhh', 'mtv', 'cp', 'jsc', 'dntn', 'co ltd', 'ltd', 'company', 'corp'];

/** Lower case, no accents, only a-z and 0-9 separated by single spaces. */
function normalize(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The name without the legal form, e.g. "CÔNG TY CP DỊCH VỤ GIAO HÀNG NHANH." -> "dich vu giao hang nhanh". */
function core(str) {
  let s = ' ' + normalize(str) + ' ';
  for (const p of LEGAL_PHRASES) s = s.replace(new RegExp(` ${p} `, 'g'), ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function couldnt(reason, excerpt, source_url = '') {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const started = Date.now();
    const wanted = core(keyword);
    if (!wanted) return couldnt('other', 'no usable words in the company name after removing the legal form');

    const query = wanted;
    const matches = new Map(); // one record per distinct company_name as written on the site
    let firstUrl = '';
    let total = null;
    let scanned = 0;
    let complete = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > BUDGET_MS) {
        return couldnt('timeout', `stopped after ${scanned} of ${total ?? '?'} results; the search was not read to the end`, firstUrl);
      }
      const offset = page * PAGE;
      const url = `${API}?q=${encodeURIComponent(query)}&limit=${PAGE}&o=${offset}`;
      if (!firstUrl) firstUrl = url;

      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.vieclamtot.com/',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        if (/challenge|cf-mitigated|just a moment|captcha/i.test(text.slice(0, 5000))) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: text.slice(0, 200) };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 200) };
      }
      if (!data || !Array.isArray(data.ads)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 200) };
      }
      if (typeof data.total === 'number') total = data.total;

      for (const ad of data.ads) {
        scanned++;
        if (ad.category_name && normalize(ad.category_name) !== JOB_CATEGORY) continue;
        if (typeof ad.company_name !== 'string' || core(ad.company_name) !== wanted) continue;

        const name = ad.company_name.replace(/\s+/g, ' ').trim();
        let rec = matches.get(name);
        if (!rec) {
          rec = { name, ads_matched: 0, ad_ids: [], areas: [], category: 'Việc làm' };
          matches.set(name, rec);
        }
        rec.ads_matched++;
        if (rec.ad_ids.length < 10 && ad.list_id != null) rec.ad_ids.push(ad.list_id);
        if (ad.area_name && !rec.areas.includes(ad.area_name)) rec.areas.push(ad.area_name);
      }

      if (data.ads.length < PAGE || (total !== null && offset + PAGE >= total)) {
        complete = true;
        break;
      }
    }

    if (matches.size > 0) {
      const records = [...matches.values()];
      const adsTotal = records.reduce((n, r) => n + r.ads_matched, 0);
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${adsTotal} job ad(s) by "${records.map((r) => r.name).join('" / "')}" in ${scanned} search result(s) read`,
      };
    }

    if (complete) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `search returned ${total ?? scanned} result(s) for "${query}"; none has a job ad by a company named "${keyword}"`,
      };
    }

    return couldnt('other', `no match in the first ${scanned} of ${total ?? '?'} results; the search was not read to the end`, firstUrl);
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, String(err?.message || err), `${API}?q=${encodeURIComponent(core(keyword))}&limit=${PAGE}&o=0`);
  }
}
