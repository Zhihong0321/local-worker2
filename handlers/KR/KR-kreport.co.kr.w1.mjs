export const meta = {
  task: 'KR-kreport.co.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'reg_no', 'corp_no', 'representative', 'status', 'company_size', 'address', 'established', 'industry', 'phone', 'ipo_status', 'kedcd'],
  canary: { found: '삼성전자(주)', not_found: '가나다라마바사하지않음주식회사' },
};

// kreport.co.kr (no www) answers; www.kreport.co.kr redirects to koreport.co.kr, which returns 400 to this client.
const API = 'https://kreport.co.kr/api/v1/ss/getSearchList';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;        // the site returns 10 rows per page; scan at most 50 rows
const DEADLINE_MS = 40000;  // do not start a new page after 40 s (the whole call must end under 60 s)

// Legal-form words in Korean names. (주) and ㈜ are normalised to (주) by NFKC before this list is used.
const LEGAL_FORMS = ['주식회사', '유한회사', '합자회사', '합명회사', '유한책임회사', '사단법인', '재단법인', '(주)', '(유)', '(사)', '(재)', '(합)'];

function stripLegal(text) {
  let s = String(text || '').normalize('NFKC');
  for (const f of LEGAL_FORMS) s = s.split(f).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

function normalize(text) {
  return stripLegal(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Which kind of legal entity a name says it is ('' when the name has no legal-form word, e.g. a sole trader).
const FORM_CATEGORY = [['주식회사', 'corp'], ['(주)', 'corp'], ['유한책임회사', 'llc'], ['유한회사', 'llc'], ['(유)', 'llc'],
  ['사단법인', 'assoc'], ['(사)', 'assoc'], ['재단법인', 'foundation'], ['(재)', 'foundation'],
  ['합자회사', 'partner'], ['합명회사', 'partner'], ['(합)', 'partner']];

function formCategory(text) {
  const s = String(text || '').normalize('NFKC');
  for (const [token, cat] of FORM_CATEGORY) if (s.includes(token)) return cat;
  return '';
}

// Same normalised name AND, when the input names a legal form, the record must name the same form.
function isSameCompany(recordName, want, inputForm) {
  if (normalize(recordName) !== want) return false;
  return inputForm === '' || formCategory(recordName) === inputForm;
}

function couldnt(reason, excerpt, source) {
  return { status: 'couldnt_check', reason, records: [], source_url: source || API, excerpt: String(excerpt || '').slice(0, 500) };
}

function toRecord(r) {
  return {
    name: r.enpNmF || '',
    reg_no: r.bzno || '',
    corp_no: r.cono || '',
    representative: r.reperNm || '',
    status: r.enpScdNm || '',
    company_size: r.enpSzeNm || '',
    address: r.bzplAddrb || '',
    established: r.estbDt || '',
    industry: r.ksic11BzcCdNm || '',
    phone: r.telNo || '',
    ipo_status: r.ipoCdNm || '',
    kedcd: r.kedcd || '',
  };
}

async function searchPage(query, page) {
  const body = JSON.stringify({
    cmQuery: query, cmQueryOption: '', cmCollection: '', cmPageNo: page, cmSortField: '', cmSortOption: 1,
    cmRowCountPerPage: 0, pdNm: '', sidoNmList: [], estbDtSt: '', estbDtEd: '', enpSzeList: [], enpIpoList: [],
    enpFcdList: [], bzcCd: '', bzcNm: '',
  });
  return fetch(API, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    },
    body,
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const want = normalize(kw);
    if (!want) return couldnt('other', 'empty company name');
    const inputForm = formCategory(kw);

    // Search on the name without the legal form (the site matches on the name words); match on the normalised full name.
    const query = stripLegal(kw) || kw;
    const matches = [];
    let total = null;
    let scanned = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > DEADLINE_MS) break;

      const res = await searchPage(query, page);
      if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return couldnt('layout_changed', text.slice(0, 300)); }

      const errCode = json?.data?.cmErrCode;
      if (json?.result !== true || errCode) {
        const msg = `result=${json?.result} code=${errCode || json?.code || ''} ${json?.data?.cmErrMsg || json?.message || ''}`;
        if (/LIMIT/i.test(String(errCode || ''))) return couldnt('blocked', msg);
        return couldnt('other', msg);
      }

      const list = json?.data?.searchRslDtoList;
      const count = json?.data?.cmTotalRowCount;
      if (!Array.isArray(list) || typeof count !== 'number') return couldnt('layout_changed', text.slice(0, 300));

      total = count;
      for (const r of list) {
        if (isSameCompany(r.enpNmF, want, inputForm)) matches.push(r);
      }
      scanned += list.length;
      if (list.length === 0 || scanned >= total) break;
    }

    const searchUrl = `${API} (POST cmQuery=${query})`;

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: searchUrl,
        excerpt: `${first.enpNmF} | ${first.bzno} | ${first.enpScdNm} | ${first.bzplAddrb} | ${matches.length} exact match(es) in ${scanned} of ${total} results`,
      };
    }

    if (total !== null && scanned >= total) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `0 exact name matches among ${scanned} results for "${query}"`,
      };
    }

    return couldnt('other', `no exact name match in the first ${scanned} of ${total} results for "${query}"; not all results were checked`, searchUrl);
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, String(err?.message || err));
  }
}
