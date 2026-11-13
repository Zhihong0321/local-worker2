export const meta = {
  task: 'TW-taftw.org.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_en', 'unit_no', 'accreditation_id', 'accreditation_version', 'accredits', 'valid_start', 'valid_end', 'status_code', 'address', 'institution', 'institution_en', 'website', 'matched_on'],
  canary: { found: '台灣給水排水設備實驗室', not_found: '台灣不存在之虛構檢測實驗室' },
};

// The name search on the TAF directory page (/directory/scheme/testLab/search/, also calLab and medLab).
// The page calls this JSON endpoint with the lab-name field (UNIT_CH_NAME). Blank accId = all lab categories.
const BASE = 'https://www.taftw.org.tw/system/modules/com.thesys.project.taf/pages/ajax/la-list-process.jsp';
const PAGE_URL = 'https://www.taftw.org.tw/directory/scheme/testLab/search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

// Legal-form words at the end of a Chinese company name (the site search fails if they are in the query).
const LEGAL_SUFFIXES = ['股份有限公司', '有限責任公司', '有限公司', '股份有限', '有限責任', '分公司', '公司'];

function nfkc(s) {
  return String(s || '').normalize('NFKC');
}

/** Keyword as sent to the site: NFKC, "(股)" spelled out, spaces removed, trailing legal form removed. */
function searchTerm(keyword) {
  let s = nfkc(keyword).replace(/[（(]\s*股\s*[）)]/g, '股份有限公司').replace(/\s+/g, '').toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s.length > suf.length && s.endsWith(suf)) { s = s.slice(0, -suf.length); changed = true; }
    }
  }
  return s;
}

/** Comparison key: same as searchTerm, plus punctuation removed. Used to compare names exactly. */
function compareKey(str) {
  return searchTerm(str).replace(/[()（）\[\]【】·．.,，、\-_/]/g, '');
}

function txt(v) {
  return v && typeof v === 'object' ? String(v.zh_TW || '') : String(v || '');
}

function enTxt(v) {
  return v && typeof v === 'object' ? String(v.en || '') : '';
}

function failure(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

function buildUrl(term, pageIndex) {
  return `${BASE}?accId=&lang=zh_TW&pageSize=${PAGE_SIZE}&pageIndex=${pageIndex}&unitChName=${encodeURIComponent(term)}`;
}

/** Fetch one result page. Returns { data } or { failure }. */
async function getPage(term, pageIndex) {
  const url = buildUrl(term, pageIndex);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': PAGE_URL },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { failure: failure(timedOut ? 'timeout' : 'other', url, err && err.message ? err.message : err) };
  }
  if (res.status === 403 || res.status === 429) {
    return { failure: failure('blocked', url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { failure: failure('http_error', url, `HTTP ${res.status}`) };
  }
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    const blockedPage = /captcha|驗證碼|login|登入/i.test(body.slice(0, 2000));
    return { failure: failure(blockedPage ? 'blocked' : 'layout_changed', url, body.slice(0, 300)) };
  }
  if (!json || json.success === false) {
    return { failure: failure('other', url, `site said success=false: ${json && json.message ? json.message : ''}`) };
  }
  if (!Array.isArray(json.itemList) || typeof json.queryCount !== 'number') {
    return { failure: failure('layout_changed', url, body.slice(0, 300)) };
  }
  return { data: json, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (typeof keyword !== 'string' || !keyword.trim()) {
      return failure('other', PAGE_URL, 'empty keyword');
    }
    const term = searchTerm(keyword);
    const key = compareKey(keyword);
    // The site search matches Chinese names only (an English query returns 0 rows), so 0 rows would not prove absence.
    if (!term || !/[㐀-鿿]/.test(term) || !key) {
      return failure('other', buildUrl(term, 1), 'the site search matches Chinese names only; this name has no Chinese characters');
    }

    const first = await getPage(term, 1);
    if (first.failure) return first.failure;
    const page1 = first.data;
    const sourceUrl = first.url;

    if (page1.queryCount === 0 || page1.itemList.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `The site returned 0 rows for "${term}".`,
      };
    }

    const pageCount = Number(page1.pageCount) || 1;
    if (pageCount > MAX_PAGES) {
      return failure('other', sourceUrl, `${page1.queryCount} rows match "${term}", more than the ${MAX_PAGES} pages checked`);
    }

    let items = [...page1.itemList];
    if (pageCount > 1) {
      const rest = [];
      for (let p = 2; p <= pageCount; p++) rest.push(getPage(term, p));
      const pages = await Promise.all(rest);
      for (const p of pages) {
        if (p.failure) return p.failure;
        items = items.concat(p.data.itemList);
      }
    }

    // Every row must be read before a "not found" is possible.
    const seen = new Set();
    items = items.filter((it) => {
      const id = `${it.unitNo || ''}|${it.accreditationId || ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (items.length !== page1.queryCount) {
      return failure('other', sourceUrl, `read ${items.length} of ${page1.queryCount} rows`);
    }

    const records = [];
    for (const it of items) {
      const matchedOn = [];
      if (compareKey(txt(it.unitName)) === key) matchedOn.push('unitName');
      if (compareKey(txt(it.institutionName)) === key) matchedOn.push('institutionName');
      if (matchedOn.length === 0) continue;
      records.push({
        name: txt(it.unitName),
        name_en: enTxt(it.unitName),
        unit_no: it.unitNo || '',
        accreditation_id: it.accreditationId || '',
        accreditation_version: it.accreditVersion || '',
        accredits: it.accreditDependOn || '',
        valid_start: String(it.accreditValidStartDate || '').slice(0, 10),
        valid_end: String(it.accreditValidEndDate || '').slice(0, 10),
        status_code: it.status || '',
        address: txt(it.address),
        institution: txt(it.institutionName),
        institution_en: enTxt(it.institutionName),
        website: it.website || '',
        matched_on: matchedOn.join('+'),
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: `The site returned ${items.length} row(s) for "${term}", none with the same name as "${keyword}".`,
      };
    }

    return {
      status: 'found', reason: '', records, source_url: sourceUrl,
      excerpt: records.map((r) => `${r.name} | ${r.accreditation_id} | ${r.accredits} | valid ${r.valid_start} to ${r.valid_end}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    return failure('other', PAGE_URL, err && err.message ? err.message : err);
  }
}
