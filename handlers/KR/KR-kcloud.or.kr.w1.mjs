// KR-kcloud.or.kr — w1
// Korea AI Cloud Industry Association (한국인공지능클라우드산업협회, formerly Korea Cloud Industry Association)
// "확인서 발급현황" (certificate issuance register) — the list of cloud services whose authenticity has been
// verified by the association. The public page /form/list.php?M2_IDX=25890 is a Vue page whose table is empty
// in the HTML; it is filled by a plain JSON endpoint the page itself calls:
//   POST https://kcloud.or.kr/api/form.list.php  (multipart/form-data)
//   KEY=<public page key>, F_IDX=1230, menu2_id=25890, PAGE=<n>, search_field=A, SC_WORD=<keyword>, imgsize=...
// No login, no captcha, 12 records per page.

const API = 'https://kcloud.or.kr/api/form.list.php';
const LIST_PAGE = 'https://kcloud.or.kr/form/list.php?M2_IDX=25890';
const KEY = 'ce5vq5uwb0ok0cob4vqswuv36r6hlsj4';
const F_IDX = '1230';
const MENU2 = '25890';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PER_PAGE = 12;
const MAX_PAGES = 12; // per search variant; the register has ~600 rows so a company search is normally 1 page
const DELAY_MS = 1100; // one request a second, politely

export const meta = {
  task: 'KR-kcloud.or.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'service', 'ceo', 'service_url', 'service_model', 'regnum', 'auth_date', 'expire_date', 'state', 'publisher'],
  canary: { found: '㈜솔빛시스템', not_found: '(주)플랜아이' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return stripCompanyForm(s)
    .toUpperCase()
    .replace(/[^0-9A-Z\uAC00-\uD7A3]/g, '');
}

// "(주)플랜아이" -> "플랜아이", "더블유피솔루션즈㈜" -> "더블유피솔루션즈"
function stripCompanyForm(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[㈜㈔]/g, ' ')
    .replace(/\((주|유|사|재|합|자)\)/g, ' ')
    .replace(/(주식회사|유한회사|유한책임회사|합자회사|합명회사|사단법인|재단법인|법인)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// content comes back either as an array of {name,value} or (older rows) as a keyed object of the same
function fieldsOf(item) {
  const c = item && item.content;
  const arr = Array.isArray(c) ? c : c && typeof c === 'object' ? Object.values(c) : [];
  const o = {};
  for (const x of arr) if (x && x.name) o[String(x.name)] = x.value == null ? '' : String(x.value);
  const fb = Array.isArray(item && item.FB) ? item.FB : [];
  for (const el of fb) if (el && el.el_name && o[el.el_name] === undefined) o[el.el_name] = el.el_value == null ? '' : String(el.el_value);
  return o;
}

function isListJson(j) {
  return (
    !!j &&
    typeof j === 'object' &&
    j.success === true &&
    Array.isArray(j.items) &&
    j.tot !== undefined &&
    Number(j.tot) > 0 &&
    typeof j.topa !== 'undefined'
  );
}

// the "no rows" answer of the same endpoint: {"success":false,"msg":"등록된 정보가 없습니다."}
function isEmptyAnswer(j) {
  return !!j && typeof j === 'object' && j.success === false && /등록된\s*정보가\s*없/.test(String(j.msg || ''));
}

async function callApi(scWord, page) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const fd = new FormData();
    fd.append('KEY', KEY);
    fd.append('F_IDX', F_IDX);
    fd.append('menu2_id', MENU2);
    fd.append('PAGE', String(page));
    fd.append('search_field', 'A');
    fd.append('SC_WORD', scWord);
    fd.append('imgsize', '218x140');
    const res = await fetch(API, {
      method: 'POST',
      body: fd,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/javascript, */*; q=0.01', Referer: LIST_PAGE },
      signal: ctl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { err: res.status === 403 || res.status === 429 ? 'blocked' : 'http_error', detail: 'HTTP ' + res.status };
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { err: 'layout_changed', detail: 'answer is not JSON: ' + text.slice(0, 120) };
    }
    return { json };
  } catch (e) {
    if (e && e.name === 'AbortError') return { err: 'timeout', detail: 'request timed out' };
    return { err: 'other', detail: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function stateOf(expire) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(expire || ''))) return '';
  const today = new Date().toISOString().slice(0, 10);
  return String(expire).slice(0, 10) >= today ? '유효' : '무효';
}

function toRecord(item) {
  const f = fieldsOf(item);
  const service = (item && item.title && item.title.value) || f['서비스명'] || '';
  return {
    name: f['회사명'] || '',
    service: String(service),
    ceo: f['대표자명'] || '',
    service_url: f['서비스 URL'] || f['서비스URL'] || '',
    service_model: f['서비스 모델'] || '',
    regnum: f['인증번호'] || '',
    auth_date: f['인증일'] || '',
    expire_date: f['만료일'] || '',
    state: stateOf(f['만료일']),
    publisher: f['발행처'] || '',
    link: (item && item.link) || LIST_PAGE,
    _raw: f,
  };
}

function matches(recordName, keywordNorm) {
  const n = norm(recordName);
  if (!n || !keywordNorm) return false;
  if (n === keywordNorm) return true;
  if (keywordNorm.length >= 4 && n.includes(keywordNorm)) return true;
  if (n.length >= 4 && keywordNorm.includes(n)) return true;
  // a partly typed name still identifies the company: "솔빛시" -> "솔빛시스템"
  if (keywordNorm.length >= 3 && n.startsWith(keywordNorm)) return true;
  return false;
}

/** Look one company up. Must never throw. */
export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_PAGE, excerpt: 'empty keyword' };

  const triedNotes = [];
  let requests = 0;

  // 1) liveness marker: an unfiltered call must still return the register rows
  const base = await callApi('', 1);
  requests++;
  if (base.err) {
    return { status: 'couldnt_check', reason: base.err, records: [], source_url: LIST_PAGE, excerpt: 'baseline call failed: ' + (base.detail || '') };
  }
  if (!isListJson(base.json)) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: LIST_PAGE,
      excerpt: 'unfiltered api/form.list.php answered without success/items/tot/topa: ' + JSON.stringify(base.json).slice(0, 300),
    };
  }
  const registerTotal = Number(base.json.tot);
  const pageCountAll = Math.ceil(registerTotal / PER_PAGE);
  triedNotes.push('register holds ' + registerTotal + ' service rows');

  // 2) search the register for the company name (and a variant without the corporate form)
  const variants = [];
  for (const v of [kw, stripCompanyForm(kw)]) {
    const t = String(v || '').trim();
    if (t && !variants.includes(t)) variants.push(t);
  }

  const keywordNorm = norm(kw) || norm(stripCompanyForm(kw));
  const found = [];
  const seen = new Set();
  let truncated = false;
  let zeroHitVariants = 0;

  for (const v of variants) {
    if (requests > MAX_PAGES + 3) {
      truncated = true;
      break;
    }
    if (requests > 1) await sleep(DELAY_MS);
    const first = await callApi(v, 1);
    requests++;
    if (first.err) {
      return { status: 'couldnt_check', reason: first.err, records: [], source_url: LIST_PAGE, excerpt: 'search "' + v + '" failed: ' + (first.detail || '') };
    }
    if (isEmptyAnswer(first.json)) {
      zeroHitVariants++;
      triedNotes.push('search "' + v + '": 등록된 정보가 없습니다 (0 rows)');
      continue;
    }
    if (!isListJson(first.json)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: LIST_PAGE,
        excerpt: 'search "' + v + '" answered an unexpected shape: ' + JSON.stringify(first.json).slice(0, 300),
      };
    }

    const tot = Number(first.json.tot);
    const pages = Math.max(1, Math.ceil(tot / PER_PAGE));
    const scanPages = Math.min(pages, MAX_PAGES);
    if (pages > scanPages) truncated = true;
    triedNotes.push('search "' + v + '": ' + tot + ' rows, scanned ' + scanPages + '/' + pages + ' pages');

    let items = first.json.items.slice();
    for (let p = 2; p <= scanPages; p++) {
      if (requests > MAX_PAGES + 3) { truncated = true; break; }
      await sleep(DELAY_MS);
      const nxt = await callApi(v, p);
      requests++;
      if (nxt.err) {
        return { status: 'couldnt_check', reason: nxt.err, records: [], source_url: LIST_PAGE, excerpt: 'page ' + p + ' of search "' + v + '" failed: ' + (nxt.detail || '') };
      }
      if (!nxt.json || nxt.json.success !== true || !Array.isArray(nxt.json.items)) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: LIST_PAGE,
          excerpt: 'page ' + p + ' of search "' + v + '" answered an unexpected shape',
        };
      }
      items = items.concat(nxt.json.items);
    }

    for (const item of items) {
      const rec = toRecord(item);
      if (!matches(rec.name, keywordNorm)) continue;
      const id = String((item && item.board_id) || rec.regnum || rec.name + '|' + rec.service);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(rec);
    }
    if (found.length) break;
  }

  if (found.length) {
    const clean = found.map((r) => {
      const c = { ...r };
      delete c._raw;
      return c;
    });
    const excerpt =
      '확인서 발급현황: ' +
      found
        .map(
          (r) =>
            '회사명 ' + r.name + ' | 서비스명 ' + r.service + ' | 인증번호 ' + r.regnum + ' | 인증일 ' + r.auth_date +
            ' ~ 만료일 ' + r.expire_date + ' (' + r.state + ') | 서비스 모델 ' + r.service_model
        )
        .join(' // ')
        .slice(0, 500);
    return { status: 'found', reason: '', records: clean, source_url: found[0].link || LIST_PAGE, excerpt };
  }

  if (truncated) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LIST_PAGE,
      excerpt: ('no name match in the scanned rows, but the search was too broad to read fully (' + triedNotes.join('; ') + ')').slice(0, 500),
    };
  }

  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: LIST_PAGE,
    excerpt: ('확인서 발급현황 (' + registerTotal + ' rows, ' + pageCountAll + ' pages, keyword searched): ' + triedNotes.join('; ')).slice(0, 500),
  };
}
