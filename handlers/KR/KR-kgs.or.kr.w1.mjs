export const meta = {
  task: 'KR-kgs.or.kr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'region', 'address', 'phone', 'certification_period'],
  canary: { found: '거성특수가스협동조합', not_found: '세무법인 혜움' },
};

const BASE = 'https://www.kgs.or.kr/kgs/abbf/board.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PLACEHOLDER = '내용이 없습니다.';

const strip = (s) => s
  .replace(/\(주\)|\(유\)|\(사\)|\(합\)|\(재\)|㈜|주식회사|유한회사|유한책임회사|합자회사|합명회사|사단법인|재단법인/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const variants = (kw) => {
  const raw = String(kw || '').trim();
  const s = strip(raw);
  const out = [raw, s, s.replace(/\s+/g, ''), raw.replace(/\s+/g, '')];
  return [...new Set(out.filter(Boolean))];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function url(q, page) {
  const p = new URLSearchParams({
    boardId: 'ABBF',
    pageIndex: String(page),
    searchType: '1',           // 업체명
    searchText: q,
  });
  return `${BASE}?${p.toString()}`;
}

function parse(html) {
  const cm = html.match(/전체\s*<span>\s*([\d,]+)\s*<\/span>\s*건/);
  const rows = [...html.matchAll(
    /<td data-th="지역">([^<]*)<\/td>\s*<td data-th="업체명" class="tit">([^<]*)<\/td>\s*<td data-th="주소" class="tit">([^<]*)<\/td>\s*<td data-th="전화번호">([^<]*)<\/td>\s*<td data-th="">([^<]*)<\/td>/g
  )].map((m) => ({
    region: m[1].trim(),
    name: m[2].trim(),
    address: m[3].trim(),
    phone: m[4].trim(),
    certification_period: m[5].trim(),
  })).filter((r) => r.name && r.name !== PLACEHOLDER);
  return {
    marker: /우수판매인증업체 목록표/.test(html) && /ABBFForm|boardId" value="ABBF"/.test(html),
    total: cm ? Number(cm[1].replace(/,/g, '')) : null,
    rows,
  };
}

async function get(urlStr) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(urlStr, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ko-KR,ko;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function getWithRetry(urlStr) {
  let lastErr;
  let lastResp = null;
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(1500);
    try {
      const r = await get(urlStr);
      lastResp = r;
      if (r.status === 200) return r;
      lastErr = Object.assign(new Error('HTTP ' + r.status), { http: true });
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

const excerptOf = (html) => {
  const i = html.indexOf('data-th="업체명"');
  const start = Math.max(0, i - 200);
  const slice = html.slice(start, start + 3000);
  return slice.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
};

export default async function lookup(keyword) {
  const tried = [];
  try {
    let sawLayout = false;
    for (const q of variants(keyword)) {
      if (tried.length) await sleep(1200);
      const u = url(q, 1);
      tried.push(q);
      let r;
      try {
        r = await getWithRetry(u);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: u, excerpt: '' };
        }
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: u, excerpt: String(e && e.message || e).slice(0, 200) };
      }
      if (r.status === 403 || r.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: u, excerpt: `HTTP ${r.status}` };
      }
      if (r.status !== 200) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: u, excerpt: `HTTP ${r.status}` };
      }
      if (/captcha|자동입력|로봇|Access Denied|차단되었습니다/i.test(r.body.slice(0, 4000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: u, excerpt: '보안 차단 페이지' };
      }
      const p = parse(r.body);
      if (!p.marker || p.total === null) continue; // not the expected table -> try next variant
      sawLayout = true;
      if (p.total > 0) {
        let rows = p.rows;
        // paging: at most one extra page (10 rows/page) to keep it polite
        if (p.total > rows.length) {
          await sleep(1200);
          try {
            const r2 = await get(url(q, 2));
            if (r2.status === 200) {
              const p2 = parse(r2.body);
              if (p2.marker) rows = rows.concat(p2.rows);
            }
          } catch { /* keep page 1 */ }
        }
        const uniq = [];
        const seen = new Set();
        for (const row of rows) {
          const k = row.name + '|' + row.address;
          if (!seen.has(k)) { seen.add(k); uniq.push(row); }
        }
        if (uniq.length) {
          return {
            status: 'found',
            reason: '',
            records: uniq,
            source_url: u,
            excerpt: excerptOf(r.body) || `한국가스안전공사 우수판매업체인증 등록 ${p.total}건`,
          };
        }
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: u,
        excerpt: `우수판매업체인증(ABBF) 검색 '${q}' → 전체 ${p.total}건, 해당 업체 없음`,
      };
    }
    if (!sawLayout) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url(variants(keyword)[0] || '', 1),
        excerpt: '우수판매업체인증 목록표(ABBF)를 찾지 못했습니다.',
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url(variants(keyword)[0] || '', 1),
      excerpt: '우수판매업체인증(ABBF) 검색 결과 0건',
    };
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String((e && e.message) || e).slice(0, 200) };
  }
}
