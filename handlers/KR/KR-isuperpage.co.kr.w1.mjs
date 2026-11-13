export const meta = {
  task: 'KR-isuperpage.co.kr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'num', 'category', 'phone', 'address', 'road_address', 'detail_url'],
  canary: { found: '삼성전자', not_found: '가나다라마바사아자차카타파하' },
};

const BASE = 'https://www.isuperpage.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10;
const START_NEW_PAGE_BEFORE_MS = 25000;

// The site is EUC-KR. Build the Hangul part of the EUC-KR table from the runtime's own decoder (no table to maintain).
const EUCKR_TO_CHAR = new TextDecoder('euc-kr');
const HANGUL_BYTES = (() => {
  const map = new Map();
  for (let lead = 0xb0; lead <= 0xc8; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const ch = EUCKR_TO_CHAR.decode(Uint8Array.of(lead, trail));
      const code = ch.charCodeAt(0);
      if (ch.length === 1 && code >= 0xac00 && code <= 0xd7a3) map.set(ch, [lead, trail]);
    }
  }
  return map;
})();

function toEucKrPercent(str) {
  const bytes = [];
  for (const ch of str) {
    if (ch.charCodeAt(0) < 0x80) bytes.push(ch.charCodeAt(0));
    else if (HANGUL_BYTES.has(ch)) bytes.push(...HANGUL_BYTES.get(ch));
    else throw new Error(`cannot encode character for the site: ${ch}`);
  }
  return bytes.map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

// Legal-form words are removed on both sides: the site returns 0 results for "삼성전자주식회사" but lists "삼성전자".
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/주식회사|유한책임회사|유한회사|합자회사|합명회사|사단법인|재단법인|㈜|\(주\)|\(유\)|\(사\)|\(재\)/g, '')
    .replace(/[^0-9a-z가-힣]/g, '');
}

const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' };

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let searchUrl = `${BASE}/search.asp`;
  try {
    const kwNorm = normalize(keyword);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'no name left to search after removing the legal form' };
    }
    const term = String(keyword).replace(/주식회사|유한책임회사|유한회사|합자회사|합명회사|사단법인|재단법인|㈜|\(주\)|\(유\)|\(사\)|\(재\)/g, ' ').replace(/\s+/g, ' ').trim();
    const encoded = toEucKrPercent(term);
    searchUrl = `${BASE}/search.asp?searchWord=${encoded}`;

    const matches = [];
    let total = null;
    let pageSize = 10;
    let scannedAll = false;
    let lastPage = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > START_NEW_PAGE_BEFORE_MS) break;
      lastPage = page;
      const pageUrl = `${BASE}/search/s_pagedata_page.asp?x=&y=&searchWord=${encoded}&page=${page}&city=&gu=&dong=&addr4=&pdc=10`;
      const res = await fetch(pageUrl, { headers: { ...headers, 'Referer': searchUrl }, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
      }
      const text = EUCKR_TO_CHAR.decode(await res.arrayBuffer());
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
      }
      if (!data || !Array.isArray(data.poiList) || data.totalCount === undefined) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
      }
      total = parseInt(data.totalCount, 10);
      pageSize = parseInt(data.pageSize, 10) || pageSize;
      for (const item of data.poiList) {
        if (normalize(item.sangho) !== kwNorm) continue;
        matches.push({
          name: item.sangho,
          num: String(item.num || ''),
          category: item.clas_name || '',
          phone: item.tel || '',
          address: item.t_addr || '',
          road_address: item.road_addr || '',
          detail_url: `${BASE}/search_detail.asp?id=${item.num}`,
        });
      }
      if (data.poiList.length === 0 || page * pageSize >= total) {
        scannedAll = true;
        break;
      }
    }

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: searchUrl,
        excerpt: `${first.name} | ${first.category} | ${first.phone} | ${first.address}`.slice(0, 500),
      };
    }

    if (!scannedAll) {
      const timedOut = Date.now() - started > START_NEW_PAGE_BEFORE_MS;
      return {
        status: 'couldnt_check',
        reason: timedOut ? 'timeout' : 'other',
        records: [],
        source_url: searchUrl,
        excerpt: `no exact match in the first ${lastPage} pages of ${total} results`,
      };
    }

    return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 exact matches among ${total ?? 0} results` };
  } catch (err) {
    const name = err && err.name;
    return {
      status: 'couldnt_check',
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
