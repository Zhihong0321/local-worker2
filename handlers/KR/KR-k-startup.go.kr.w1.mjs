export const meta = {
  task: 'KR-k-startup.go.kr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'representative', 'program', 'support_year', 'location', 'founded', 'business_reg_no'],
  canary: { found: '에스지랩 주식회사', not_found: '가나다라마바사아자차카타파하 주식회사' },
};

// K-Startup 우수기업정보: the only per-company record list on the portal (companies that received a support
// program). List pages are plain GET pages; each company has a detail page with its registered details.
const BASE = 'https://www.k-startup.go.kr/web/contents/webEXCENTRPINFO.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_PAGES = 10;
const DEADLINE_MS = 45000;

const listUrl = (page) => `${BASE}?schM=list&page=${page}&viewCount=16`;
const detailUrl = (sn) => `${BASE}?schM=view&exceSn=${sn}`;

// Legal forms and organisation markers, removed before comparing names.
const LEGAL = /주식회사|유한회사|유한책임회사|합자회사|합명회사|사단법인|재단법인|\(주\)|\(유\)|\(사\)|\(재\)|㈜/g;

function normalise(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ') // program prefix such as [KSC 지원사업]
    .replace(LEGAL, ' ')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, '');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function parseList(html) {
  const items = [];
  const re = /fn_goView\('(\d+)'\)[\s\S]*?<div class="gallery_tit">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) items.push({ exceSn: m[1], title: cleanText(m[2]) });
  return items;
}

// Value of one "label | value" row in the company table of a detail page.
function field(html, label) {
  const re = new RegExp(`<span>${label}</span>\\s*</div>\\s*</li>\\s*<li class="td[^"]*">\\s*<div class="inner">\\s*<span>([\\s\\S]*?)</span>`);
  const m = html.match(re);
  return m ? cleanText(m[1]) : '';
}

async function fetchText(url, started) {
  if (Date.now() - started > DEADLINE_MS) throw Object.assign(new Error('deadline'), { kind: 'timeout', url });
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) throw Object.assign(new Error('blocked'), { kind: 'blocked', url, status: res.status });
  if (!res.ok) throw Object.assign(new Error('http'), { kind: 'http_error', url, status: res.status });
  return res.text();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = normalise(keyword);
  let page = 1;
  try {
    if (!kw) return couldnt('other', listUrl(1), 'the name is empty after removing the legal form');

    // Read every list page (16 per page) until a page comes back empty.
    const all = [];
    for (; page <= MAX_PAGES; page++) {
      const url = listUrl(page);
      const html = await fetchText(url, started);
      if (page === 1 && !html.includes('우수기업정보')) return couldnt('layout_changed', url, html);
      const items = parseList(html);
      if (items.length === 0) {
        if (page === 1) return couldnt('layout_changed', url, 'no company entries found on the list page');
        break;
      }
      all.push(...items);
      if (page === MAX_PAGES) return couldnt('other', url, 'the list is longer than the handler reads');
    }

    const matches = all.filter((it) => normalise(it.title) === kw);
    const scope = `우수기업정보 list, ${all.length} entries read`;

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: listUrl(1),
        excerpt: `not in ${scope}; this portal lists only companies that received a support program`,
      };
    }

    const records = [];
    for (const m of matches) {
      const url = detailUrl(m.exceSn);
      const html = await fetchText(url, started);
      records.push({
        name: field(html, '기업명') || m.title.replace(/\[[^\]]*\]/g, '').trim(),
        representative: field(html, '기업 대표자명'),
        program: field(html, '지원사업명'),
        support_year: field(html, '지원년도'),
        location: field(html, '기업 소재지'),
        founded: field(html, '기업 설립일자'),
        business_reg_no: field(html, '사업자등록번호'),
      });
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: detailUrl(matches[0].exceSn),
      excerpt: `${first.name} | ${first.program} | ${first.support_year}`.slice(0, 500),
    };
  } catch (err) {
    const kind = err?.kind || (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other');
    return couldnt(kind, err?.url || listUrl(page), err?.status ? `HTTP ${err.status}` : String(err?.message || err));
  }
}
