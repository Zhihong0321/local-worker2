export const meta = {
  task: 'KR-emedi.mfds.go.kr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'item_name', 'permit_no', 'grade', 'item_state', 'product_name', 'model', 'permit_date', 'item_seq', 'valid_until', 'entp_permit_no', 'industry', 'entp_state'],
  canary: { found: '애보트메디칼코리아(유)', not_found: '세무법인 혜움' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_URL = 'https://emedi.mfds.go.kr/search/data/list';
const PAGE_URL = 'https://emedi.mfds.go.kr/search/data/MNU20237';
// Only the leading columns of a row are stable (trailing cells are dropped for some rows),
// so we read fields by their header position and stop before the manufacturer block.
const MAX_FIELD_INDEX = 16;

const FIELDS = {
  '업체명': 'name',
  '품목명': 'item_name',
  '품목허가번호': 'permit_no',
  '품목등급': 'grade',
  '품목상태': 'item_state',
  '취소/취하일자': 'cancel_date',
  '품목분류번호': 'classification_no',
  '제품명': 'product_name',
  '모델명': 'model',
  '품목허가일자': 'permit_date',
  '품목일련번호': 'item_seq',
  '품목유효기간(만료일)': 'valid_until',
  '업허가번호': 'entp_permit_no',
  '업종': 'industry',
  '업상태': 'entp_state',
  '업하가일자': 'entp_permit_date',
};

function baseFields(entpName) {
  return {
    chkList: '1', chkGroup: 'GROUP_BY_FIELD_01', chkBrief: 'Y',
    toggleBtnState: '', nowPageNum: '1', tabGubun: '1',
    tcsbizRsmptSeCdNm: '', indtyCdNm: '', itemStateNm: '', mnftrNtnCdNm: '',
    tmpQrBarcode: '', query2: '', udidiCode: '', grade: '0', itemState: '',
    itemNoFullname: '', entpName, indtyCd: '1|2|21|22', tcsbizRsmptSeCd: '',
    mdentpPrmno: '', mnfacrNm: '', typeName: '', brandName: '', query: '',
    rcprslryCdInptvl: '', mdClsfNo: '', itemName: '',
    prdlPrmDtFrom: '', prdlPrmDtTo: '', validDateFrom: '', validDateTo: '',
    rcprslryTrgtYn: '', traceManageTargetYn: '', mitncMngPpPrdtYn: '',
    hmnbdTspnttyMdYn: '', xprtppYn: '', test2: '',
    pageNum: '1', searchAfKey: '', searchYn: '', searchOn: 'Y', sort: '', sortOrder: '',
    ean13: 'false',
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripComments(h) { return h.replace(/<!--[\s\S]*?-->/g, ''); }

function clean(s) {
  return s.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#40;/g, '(').replace(/&#41;/g, ')').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/** Build header-name -> cell index, skipping columns that carry no <td>. */
function cellMap(html) {
  const h = stripComments(html);
  const thead = h.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
  if (!thead) return null;
  const heads = [...thead[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => clean(m[1]));
  if (!heads.length) return null;
  const map = {};
  let idx = 0;
  for (const name of heads) {
    if (idx <= MAX_FIELD_INDEX) map[name] = idx;
    idx += 1;
  }
  return map;
}

function parseRows(html, map) {
  const h = stripComments(html);
  const tb = h.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tb) return [];
  const out = [];
  for (const trm of tb[1].matchAll(/<tr id="itemTr_(\d+)"([\s\S]*?)<\/tr>/g)) {
    const cells = [...trm[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => clean(m[1]));
    const rec = {};
    for (const [head, field] of Object.entries(FIELDS)) {
      const i = map[head];
      if (i !== undefined && cells[i] !== undefined) rec[field] = cells[i];
    }
    if (!rec.item_seq) {
      const sq = trm[2].match(/data-meddevseq="(\d+)"/);
      if (sq) rec.item_seq = sq[1];
    }
    out.push(rec);
  }
  return out;
}

function shortForms(name) {
  const forms = [];
  const stripped = name
    .replace(/^\(주\)\s*/, '').replace(/\s*\(주\)$/, '')
    .replace(/^\(유\)\s*/, '').replace(/\s*\(유\)$/, '')
    .replace(/^\(사\)\s*/, '').replace(/^\(재\)\s*/, '')
    .replace(/^주식회사\s*/, '').replace(/\s*주식회사$/, '')
    .replace(/^유한회사\s*/, '').replace(/\s*유한회사$/, '')
    .trim();
  if (stripped && stripped !== name && stripped.length >= 2) forms.push(stripped);
  return forms;
}

async function query(entpName) {
  const res = await fetch(LIST_URL, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'accept': 'text/html, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      'referer': PAGE_URL,
      'origin': 'https://emedi.mfds.go.kr',
    },
    body: new URLSearchParams(baseFields(entpName)).toString(),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

export default async function lookup(keyword) {
  const url = PAGE_URL;
  try {
    const name = String(keyword == null ? '' : keyword).replace(/\s+/g, ' ').trim();
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: 'empty company name given' };
    }

    const attempts = [name, ...shortForms(name)];
    let lastTotal = null;
    let lastText = '';

    for (let i = 0; i < attempts.length; i++) {
      if (i > 0) await sleep(1100); // stay under one request a second
      let r;
      try {
        r = await query(attempts[i]);
      } catch (e) {
        const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return {
          status: 'couldnt_check', reason: isTimeout ? 'timeout' : 'other', records: [], source_url: url,
          excerpt: String(e && e.message ? e.message : e).slice(0, 200),
        };
      }
      lastText = r.text;
      if (r.status !== 200) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: 'HTTP ' + r.status };
      }
      // layout markers we rely on
      const hasContainer = /id="resultContents"/.test(r.text);
      const totalM = r.text.match(/id="totSearchCnt"\s+value="(\d+)"/);
      const map = cellMap(r.text);
      if (!hasContainer || !totalM || !map || !('업체명' in map)) {
        return {
          status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
          excerpt: clean(r.text).slice(0, 300),
        };
      }
      const total = Number(totalM[1]);
      lastTotal = total;
      if (total === 0 && !/조회 결과가 없습니다/.test(r.text)) {
        return {
          status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
          excerpt: clean(r.text).slice(0, 300),
        };
      }
      const recs = parseRows(r.text, map).filter(x => x.name || x.permit_no || x.item_name);
      if (total > 0 && recs.length > 0) {
        const excerpt = recs.slice(0, 2).map(x =>
          [x.name, x.item_name, x.permit_no, x.grade && x.grade + '등급', x.item_state, x.model, x.permit_date]
            .filter(Boolean).join(' / ')
        ).join(' || ').slice(0, 500);
        return { status: 'found', reason: '', records: recs, source_url: url, excerpt };
      }
    }

    return {
      status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: ('"' + name + '" 에 대한 의료기기 검색 결과입니다. 총 0 건 조회 결과가 없습니다.').slice(0, 500),
    };
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}
