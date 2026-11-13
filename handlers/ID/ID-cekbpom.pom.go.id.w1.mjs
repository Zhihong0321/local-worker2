export const meta = {
  task: 'ID-cekbpom.pom.go.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'role', 'product_register', 'product_name', 'brand', 'status', 'product_date', 'product_expired', 'application', 'category', 'address', 'district', 'province', 'product_id'],
  canary: { found: 'PT NUGRAHA INDAH CITARASA INDONESIA', not_found: 'PT TIDAK ADA PERUSAHAAN INI' },
};

const BASE = 'https://cekbpom.pom.go.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;     // the server caps a page at 100 rows
const MAX_PAGES = 10;      // at most 1000 rows read per lookup
const START_LIMIT_MS = 30000; // do not start another request after 30 s

// Indonesian and common foreign legal forms, stripped from the start and end of a name before comparing.
const LEGAL = new Set(['PT', 'PERSEROAN', 'TERBATAS', 'PERSERO', 'TBK', 'CV', 'UD', 'FIRMA', 'KOPERASI',
  'SDN', 'BHD', 'BERHAD', 'PTE', 'LTD', 'LIMITED', 'PRIVATE', 'LLC', 'INC', 'CORP', 'PLC', 'GMBH', 'BV', 'CO']);

function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function coreWords(s) {
  const w = words(s);
  while (w.length && LEGAL.has(w[0])) w.shift();
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

/** Comparison key: case, punctuation, spacing and legal form removed. */
function keyOf(s) {
  return coreWords(s).join('') || words(s).join('');
}

function cookieHeader(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return set.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function toRecord(row, role) {
  const isRegistrar = role === 'registrar';
  return {
    name: isRegistrar ? row.REGISTRAR : row.MANUFACTURER_NAME,
    role,
    product_register: row.PRODUCT_REGISTER,
    product_name: row.PRODUCT_NAME,
    brand: row.PRODUCT_BRANDS,
    status: row.STATUS,
    product_date: row.PRODUCT_DATE,
    product_expired: row.PRODUCT_EXPIRED,
    application: row.APPLICATION,
    category: row.CATEGORY,
    address: isRegistrar ? row.REGISTRAR_ADD : row.MANUFACTURER_ADDRESS,
    district: isRegistrar ? row.REGISTRAR_DISTRICT_DETAIL : row.MANUFACTURER_DISTRICT_DETAIL,
    province: isRegistrar ? row.REGISTRAR_PROVINCE_DETAIL : row.MANUFACTURER_PROVINCE_DETAIL,
    product_id: row.PRODUCT_ID,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const wanted = keyOf(keyword);
  const term = coreWords(keyword).join(' ') || words(keyword).join(' ');
  const pageUrl = `${BASE}/all-produk?query=${encodeURIComponent(term)}`;
  const blocked = (src, excerpt) => ({ status: 'couldnt_check', reason: 'blocked', records: [], source_url: src, excerpt });
  const httpErr = (src, status) => ({ status: 'couldnt_check', reason: 'http_error', records: [], source_url: src, excerpt: `HTTP ${status}` });

  try {
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'empty company name' };
    }

    // Step 1: the search page gives the session cookie, the CSRF token and the data endpoint.
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) return blocked(pageUrl, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return httpErr(pageUrl, pageRes.status);

    const html = await pageRes.text();
    if (/g-recaptcha|hcaptcha|cf-chl|Access denied/i.test(html)) return blocked(pageUrl, 'bot or captcha check on the page');

    const tokenMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/i);
    const urlMatch = html.match(/window\.dataTableUrl\s*=\s*"([^"]+)"/i);
    if (!tokenMatch || !urlMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: html.slice(0, 300) };
    }
    const token = tokenMatch[1];
    const endpoint = urlMatch[1].replace(/\\\//g, '/');
    const cookie = cookieHeader(pageRes);

    // Step 2: read the result rows, page by page, and keep the ones where this company is the registrar or manufacturer.
    const matches = [];
    let start = 0;
    let total = null;
    let rowsRead = 0;
    let complete = false;
    let pages = 0;

    while (pages < MAX_PAGES && elapsed() < START_LIMIT_MS) {
      const body = new URLSearchParams({
        draw: String(pages + 1),
        start: String(start),
        length: String(PAGE_SIZE),
        query: term,
        product_register: '',
        product_name: '',
        manufacturer_name: '',
        status: '',
        manufacturer: '',
        registrar: '',
      });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-TOKEN': token,
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': BASE,
          'Referer': pageUrl,
          ...(cookie ? { 'Cookie': cookie } : {}),
        },
        body: body.toString(),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return blocked(endpoint, `HTTP ${res.status}`);
      if (!res.ok) return httpErr(endpoint, res.status);

      let json;
      try {
        json = await res.json();
      } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: endpoint, excerpt: 'the data endpoint did not return JSON' };
      }
      if (!json || !Array.isArray(json.data) || !Number.isFinite(Number(json.recordsFiltered))) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: endpoint, excerpt: JSON.stringify(json).slice(0, 300) };
      }

      total = Number(json.recordsFiltered);
      for (const row of json.data) {
        if (keyOf(row.REGISTRAR) === wanted) matches.push(toRecord(row, 'registrar'));
        else if (keyOf(row.MANUFACTURER_NAME) === wanted) matches.push(toRecord(row, 'manufacturer'));
      }

      pages += 1;
      rowsRead += json.data.length;
      start += json.data.length;
      if (json.data.length === 0 || rowsRead >= total) {
        complete = true;
        break;
      }
    }

    if (matches.length > 0) {
      const partial = complete ? '' : `; read ${rowsRead} of ${total} rows, more not read`;
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: pageUrl,
        excerpt: `${matches.length} product record(s) for "${keyword}" among ${total} search rows${partial}`,
      };
    }

    if (complete) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `search "${term}" returned ${total} rows; none has this company as registrar or manufacturer`,
      };
    }

    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: pageUrl,
      excerpt: `search "${term}" has ${total} rows; read ${rowsRead} with no match; stopped at the page or time limit`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: pageUrl, excerpt: 'the site did not answer in time' };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
