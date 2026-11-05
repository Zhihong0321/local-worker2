// KR-kcl.re.kr / w1
// KCL (Korea Conformity Laboratories) - "KC인증현황조회 > 업체명으로 조회"
// The lookup form at /site/program/cert/custnameSearchForm.do posts to a JSON endpoint
// /site/program/cert/getCertCustList.do with { custname, searchType: 'A' }.
// IMPORTANT: the servlet decodes request parameters as EUC-KR (CP949), even though the
// pages are UTF-8, so the company name must be percent-encoded from EUC-KR bytes.

export const meta = {
  task: 'KR-kcl.re.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'product', 'nation', 'address', 'rep', 'custseq'],
  canary: { found: '은민에스엔디', not_found: '세무법인 혜움' },
};

const FORM_URL = 'https://www.kcl.re.kr/site/program/cert/custnameSearchForm.do?menuid=001019';
const API_URL = 'https://www.kcl.re.kr/site/program/cert/getCertCustList.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 25000;

// ---- EUC-KR (CP949) encoding, built from the built-in decoder, no packages ----
let euckrMap = null; // char -> [lead, trail]
let ksHangul = null; // sorted codepoints of the 2350 KS X 1001 hangul syllables
let prologueMap = null; // single-byte 0x00-0x7F passthrough

function buildTables() {
  if (euckrMap) return;
  const dec = new TextDecoder('euc-kr');
  euckrMap = new Map();
  const hangul = [];
  for (let a = 0x81; a <= 0xfe; a++) {
    for (let b = 0x41; b <= 0xfe; b++) {
      const s = dec.decode(new Uint8Array([a, b]));
      if (s.length === 1 && s !== '\uFFFD') {
        euckrMap.set(s, [a, b]);
        const cp = s.codePointAt(0);
        if (cp >= 0xac00 && cp <= 0xd7a3) hangul.push(cp);
      }
    }
  }
  hangul.sort((x, y) => x - y);
  ksHangul = hangul;
}

// UHC extension block for hangul syllables that are not in KS X 1001.
function uhcHangul(cp) {
  let lo = 0, hi = ksHangul.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ksHangul[mid] < cp) lo = mid + 1; else hi = mid;
  }
  const k = cp - 0xac00 - lo; // index among extension syllables
  if (k < 5696) {
    const lead = 0x81 + Math.floor(k / 178);
    const t = k % 178;
    const trail = t < 26 ? 0x41 + t : t < 52 ? 0x61 + (t - 26) : 0x81 + (t - 52);
    return [lead, trail];
  }
  const k2 = k - 5696;
  if (k2 < 3108) {
    const lead = 0xa1 + Math.floor(k2 / 84);
    const t = k2 % 84;
    const trail = t < 26 ? 0x41 + t : t < 52 ? 0x61 + (t - 26) : 0x81 + (t - 52);
    return [lead, trail];
  }
  const k3 = k2 - 3108;
  if (k3 < 18) return [0xc6, 0x41 + k3];
  return null;
}

function euckrPercent(str) {
  buildTables();
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      const ok = /[A-Za-z0-9\-._~]/.test(ch);
      out += ok ? ch : '%' + cp.toString(16).toUpperCase().padStart(2, '0');
      continue;
    }
    let pair = euckrMap.get(ch);
    if (!pair && cp >= 0xac00 && cp <= 0xd7a3) pair = uhcHangul(cp);
    if (!pair) return null; // not encodable in this charset
    out += '%' + pair[0].toString(16).toUpperCase().padStart(2, '0') + '%' + pair[1].toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// ---- lookup ----
export default async function lookup(keyword) {
  const base = {
    status: 'couldnt_check',
    reason: 'other',
    records: [],
    source_url: FORM_URL,
    excerpt: '',
  };
  const name = String(keyword == null ? '' : keyword).trim();
  if (!name) return { ...base, reason: 'other', excerpt: 'empty input' };

  let encoded;
  try {
    encoded = euckrPercent(name);
  } catch (e) {
    return { ...base, reason: 'other', excerpt: 'EUC-KR encoder unavailable: ' + String(e && e.message || e).slice(0, 200) };
  }
  if (encoded == null) {
    return { ...base, reason: 'other', excerpt: 'company name contains characters not encodable in EUC-KR' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded; charset=EUC-KR',
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        'referer': FORM_URL,
      },
      body: 'custname=' + encoded + '&searchType=A',
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return { ...base, reason: aborted ? 'timeout' : 'http_error', excerpt: String(e && e.message || e).slice(0, 300) };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { ...base, reason: 'http_error', excerpt: 'HTTP ' + res.status, source_url: API_URL };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ...base,
      reason: 'layout_changed',
      source_url: API_URL,
      excerpt: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
  }

  // Marker we rely on: the endpoint answers {"error":"ProcessSuccess", "list":[...], "totalcount":n}
  if (!data || data.error !== 'ProcessSuccess' || !Array.isArray(data.list)) {
    return { ...base, reason: 'layout_changed', source_url: API_URL, excerpt: JSON.stringify(data).slice(0, 300) };
  }

  const list = data.list;
  if (list.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: API_URL,
      excerpt: 'KCL KC인증현황조회: 0 companies for "' + name + '" (totalcount=' + data.totalcount + ')',
    };
  }

  const records = list.slice(0, 20).map((r) => ({
    name: r.custnm,
    product: r.certitemnm,
    nation: r.ntnnm,
    address: r.prodcustloc,
    rep: r.reprenm,
    custseq: r.custseq,
  }));

  const excerpt = records
    .slice(0, 6)
    .map((r) => [r.name, r.product, r.nation].filter(Boolean).join(' / '))
    .join('\n')
    .slice(0, 500);

  return {
    status: 'found',
    reason: '',
    records,
    source_url: API_URL,
    excerpt,
  };
}
