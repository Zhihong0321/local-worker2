export const meta = {
  task: 'KR-greencertif.or.kr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'cert_no', 'cert_type', 'ministry', 'cert_date', 'valid_until'],
  canary: { found: '그린아그로텍', not_found: '세무법인 혜움' },
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BASE = 'https://www.greencertif.or.kr';

// Two public list endpoints of the Green Certification Portal. Both accept the
// company name as a plain GET parameter (sch_biz_nm) and answer with an HTML table.
const SOURCES = [
  {
    url: `${BASE}/ptl/sEnterpriseC/list.do`,
    label: '녹색전문기업확인', // Green Specialized Enterprise certificate
    colCertNo: '확인번호',
    colName: '기관명',
  },
  {
    url: `${BASE}/ptl/sTechC/list.do`,
    label: '녹색기술인증', // Green Technology certificate
    colCertNo: '인증번호',
    colName: '기관명',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cells(rowHtml) {
  const out = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml))) out.push(textOf(m[1]));
  return out;
}

async function fetchPage(src, keyword, pageIndex) {
  const url =
    `${src.url}?sch_biz_nm=${encodeURIComponent(keyword)}` +
    `&sch_cert_no=&sch_from_certdt=&sch_to_certdt=&pageIndex=${pageIndex}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ko-KR,ko;q=0.9' },
    redirect: 'follow',
  });
  const body = await res.text();
  return { status: res.status, body, url };
}

/** Parse one list page. Returns null when the page no longer looks like the known list. */
function parsePage(body, src) {
  // markers we depend on: the search form field, the list table and the total counter
  if (!body.includes('sch_biz_nm')) return null;
  if (!body.includes('class="table mt8"')) return null;
  if (!body.includes(src.colCertNo) || !body.includes(src.colName)) return null;
  const totalMatch = body.match(/전체<span class="bold">\s*(\d+)\s*<\/span>/);
  if (!totalMatch) return null;
  const total = Number(totalMatch[1]);

  const records = [];
  const tbodyRe = /<tbody>([\s\S]*?)<\/tbody>/gi;
  let tb;
  while ((tb = tbodyRe.exec(body))) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tb[1]))) {
      const c = cells(rm[1]);
      // sEnterpriseC: 번호 | 확인번호 | 기관명 | 발급부처 | 확인일자 | 유효기간
      // sTechC:        번호 | 인증번호 | 기술명 | 분류코드 | 기관명 | 발급부처 | 인증일자 | 유효기간
      if (c[0] === '번호' || c.length < 6) continue;
      let rec;
      if (c.length >= 8) {
        rec = { name: c[4], cert_no: c[1], tech: c[2], class_code: c[3], ministry: c[5], cert_date: c[6], valid_until: c[7] };
      } else {
        rec = { name: c[2], cert_no: c[1], ministry: c[3], cert_date: c[4], valid_until: c[5] };
      }
      if (!rec.name) continue;
      rec.cert_type = src.label;
      records.push(rec);
    }
  }
  return { total, records };
}

export default async function lookup(keyword) {
  const kw = typeof keyword === 'string' ? keyword.trim() : '';
  if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };

  const all = [];
  const urls = [];
  let sawAnyPage = false;

  for (const src of SOURCES) {
    let pageIndex = 1;
    let total = Infinity;
    let pages = 0;
    while (pageIndex * 10 - 10 < total && pages < 10) {
      if (pages > 0) await sleep(1000); // politeness: max one request per second
      let page;
      try {
        page = await fetchPage(src, kw, pageIndex);
      } catch (err) {
        return {
          status: 'couldnt_check',
          reason: err && err.name === 'TimeoutError' ? 'timeout' : 'http_error',
          records: [],
          source_url: src.url,
          excerpt: String((err && err.message) || err).slice(0, 300),
        };
      }
      if (page.status === 403 || page.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: page.url, excerpt: `HTTP ${page.status}` };
      }
      if (page.status !== 200) {
        return {
          status: 'couldnt_check',
          reason: 'http_error',
          records: [],
          source_url: page.url,
          excerpt: `HTTP ${page.status}`,
        };
      }
      const parsed = parsePage(page.body, src);
      if (!parsed) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: page.url,
          excerpt: textOf(page.body).slice(0, 500),
        };
      }
      sawAnyPage = true;
      total = parsed.total;
      all.push(...parsed.records);
      urls.push(page.url);
      pages += 1;
      if (parsed.records.length === 0) break;
      pageIndex += 1;
    }
  }

  if (!sawAnyPage) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: BASE, excerpt: 'no list page recognised' };
  }

  const unique = [];
  const seen = new Set();
  for (const r of all) {
    const k = `${r.cert_type}|${r.cert_no}|${r.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }

  const sourceUrl = urls[0] || `${BASE}/ptl/sEnterpriseC/list.do?sch_biz_nm=${encodeURIComponent(kw)}`;

  if (unique.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `${kw}: 0 records in 녹색전문기업확인 and 녹색기술인증 lists`,
    };
  }

  return {
    status: 'found',
    reason: '',
    records: unique,
    source_url: sourceUrl,
    excerpt: unique
      .slice(0, 5)
      .map((r) => `${r.cert_type} ${r.cert_no} ${r.name} ${r.ministry} ${r.cert_date}~${r.valid_until}`)
      .join(' | ')
      .slice(0, 500),
  };
}
