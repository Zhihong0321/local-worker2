export const meta = {
  task: 'KR-egroup.go.kr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entrprs_id', 'group', 'representative', 'founded', 'industry', 'latest_designation',
    'settlement_date', 'fiscal_year_end', 'assets', 'liabilities', 'equity', 'capital', 'employees', 'revenue',
    'net_income', 'amounts_unit'],
  canary: { found: '삼성전자(주)', not_found: '가나다라마바사아자차카타파하' },
};

const SEARCH_PAGE = 'https://www.egroup.go.kr/egps/wi/stat/kap/searchPsitnCmpnyList.do';
const SEARCH_URL = 'https://www.egroup.go.kr/egps/wi/stat/kap/selectSearchPsitnCmpnyList.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_UNIT = 30;
const MAX_PAGES = 10;
const DEADLINE_MS = 50000;

const LEGAL_FORM_BRACKETS = /\((주|유|합명|합자|사)\)/g;
const LEGAL_FORM_WORDS = /주식회사|유한회사|합자회사|합명회사|유한책임회사/g;

/** Name for comparison: NFKC, legal form removed, case, spaces and punctuation removed. */
function core(name) {
  return String(name || '').normalize('NFKC').replace(LEGAL_FORM_BRACKETS, ' ').replace(LEGAL_FORM_WORDS, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** Word sent to the site: legal form and spaces removed, other characters kept. */
function searchTerm(name) {
  return String(name || '').normalize('NFKC').replace(LEGAL_FORM_BRACKETS, ' ').replace(LEGAL_FORM_WORDS, ' ')
    .replace(/\s+/g, '');
}

/** Hangul and other KS X 1001 characters -> EUC-KR byte pair, built from the TextDecoder (no packages). */
let EUCKR_MAP = null;
function eucKrMap() {
  if (EUCKR_MAP) return EUCKR_MAP;
  const dec = new TextDecoder('euc-kr');
  const map = new Map();
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [lead, trail]);
    }
  }
  EUCKR_MAP = map;
  return map;
}

/** The portal reads search words as EUC-KR: a UTF-8 search returns nothing. */
function formEncodeEucKr(text) {
  const map = eucKrMap();
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const bytes = code < 0x80 ? [code] : (map.get(ch) || [0x3f]);
    for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function labelled(chunk, label) {
  const m = chunk.match(new RegExp(label + '\\s*:([\\s\\S]*?)</li>'));
  return m ? clean(m[1]) : '';
}

/** Parses one page of the search fragment: { total, rows } or null when the layout is not what we expect. */
function parsePage(html) {
  if (!html.includes('소속회사정보')) return null;
  const countM = html.match(/class="count">\s*([\d,]+)\s*건/);
  let total;
  if (countM) total = parseInt(countM[1].replace(/,/g, ''), 10);
  else if (html.includes('검색된 자료가 없습니다')) total = 0;
  else return null;
  const rows = [];
  for (const chunk of html.split('<li><strong style=').slice(1)) {
    const m = chunk.match(/onclick="fn_cmpnySearch\('([^']*)','([^']*)'/);
    if (!m) continue;
    const detail = {};
    for (const pm of chunk.matchAll(/<th scope="col">([^<]+)<\/th>\s*<td>([\s\S]*?)<\/td>/g)) {
      const label = clean(pm[1]);
      if (!(label in detail)) detail[label] = clean(pm[2]);
    }
    rows.push({
      name: clean(m[2]),
      entrprs_id: m[1],
      group: labelled(chunk, '기업집단'),
      representative: detail['대표자'] || '',
      founded: detail['설립일'] || '',
      industry: detail['영위업종'] || '',
      latest_designation: labelled(chunk, '최근지정년월'),
      settlement_date: detail['결산주총일'] || '',
      fiscal_year_end: detail['결산기일'] || '',
      assets: detail['자산총액'] || '',
      liabilities: detail['부채총액'] || '',
      equity: detail['자본총액'] || '',
      capital: detail['자본금'] || '',
      employees: detail['종업원수'] || '',
      revenue: detail['매출액'] || '',
      net_income: detail['당기순이익'] || '',
      amounts_unit: 'KRW million (백만원, as the site shows)',
    });
  }
  if (total > 0 && rows.length === 0) return null;
  return { total, rows };
}

async function fetchPage(term, pageIndex) {
  const enc = formEncodeEucKr(term);
  const body = `sch_entrprsNm=${enc}&searchWord1=${enc}&sch_gbn=0001&s_cnt=1&pageUnit=${PAGE_UNIT}&pageIndex=${pageIndex}`;
  return fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html, */*; q=0.01',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded; charset=EUC-KR',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': SEARCH_PAGE,
    },
    body,
    signal: AbortSignal.timeout(25000),
  });
}

const out = (status, reason, records, excerpt) => ({ status, reason, records, source_url: SEARCH_URL, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const key = core(keyword);
    const term = searchTerm(keyword);
    if (!key || !term) return out('couldnt_check', 'other', [], 'the name is empty after removing the legal form');

    let total = null;
    let scanned = 0;
    let pageIndex = 1;
    const matches = [];
    for (;;) {
      if (Date.now() - started > DEADLINE_MS) return out('couldnt_check', 'timeout', [], 'the search did not finish in time');
      const res = await fetchPage(term, pageIndex);
      if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', [], `HTTP ${res.status}`);
      if (!res.ok) return out('couldnt_check', 'http_error', [], `HTTP ${res.status}`);
      const html = await res.text();
      if (/captcha|보안문자/i.test(html)) return out('couldnt_check', 'blocked', [], 'captcha or security check page');
      const page = parsePage(html);
      if (!page) return out('couldnt_check', 'layout_changed', [], html.slice(0, 300));
      if (total === null) total = page.total;
      scanned += page.rows.length;
      for (const r of page.rows) if (core(r.name) === key) matches.push(r);
      if (page.rows.length === 0 || scanned >= total) break;
      pageIndex++;
      if (pageIndex > MAX_PAGES) {
        return out('couldnt_check', 'other', [], `${total} results for "${term}"; only the first ${MAX_PAGES * PAGE_UNIT} were checked`);
      }
    }

    if (matches.length === 0) {
      return out('not_found', '', [], `0 exact matches for "${keyword}" among ${total} search results for "${term}"`);
    }
    const first = matches[0];
    return out('found', '', matches,
      `${first.name} | 대표자 ${first.representative} | 설립일 ${first.founded} | 기업집단 ${first.group} | ` +
      `${matches.length} exact match(es) for "${keyword}"`.slice(0, 500));
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], String(err?.message || err).slice(0, 300));
  }
}
