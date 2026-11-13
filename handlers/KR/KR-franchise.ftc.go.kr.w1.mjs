export const meta = {
  task: 'KR-franchise.ftc.go.kr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'brand', 'representative', 'registration_no', 'first_registered', 'industry', 'detail_url'],
  canary: { found: '교촌에프앤비(주)', not_found: '가나다라마바사아자차카타파하' },
};

const BASE = 'https://franchise.ftc.go.kr';
const LIST = '/mnu/00013/program/userRqst/list.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_UNIT = 300;
const MAX_PAGES = 5;
const DEADLINE_MS = 45000;

// Legal-form markers (Korean). Removed before comparing names.
const LEGAL_FORMS = /\(주\)|주식회사|\(유\)|유한회사|\(유한\)|유한책임회사|\(사\)|사단법인|\(재\)|재단법인/g;

/** Comparison key: NFKC, legal form removed, lowercase, letters and digits only. */
function normalize(s) {
  return (s || '').normalize('NFKC').replace(LEGAL_FORMS, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Search term: NFKC, legal form removed, whitespace collapsed. */
function core(s) {
  return (s || '').normalize('NFKC').replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
}

function clean(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { res, text };
}

function searchUrl(term, page) {
  return `${BASE}${LIST}?column=tNm&searchKeyword=${encodeURIComponent(term)}&pageUnit=${PAGE_UNIT}` +
    (page > 1 ? `&pageIndex=${page}` : '');
}

/** Parse the result table into rows. Returns null when the table is not on the page. */
function parseRows(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbody) return null;
  const rows = [];
  for (const tr of tbody[1].match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 7) continue;
    const link = cells[1].match(/fn_moveUrl\('([^']*)',\s*'([^']*)'\)/);
    rows.push({
      name: clean(cells[1]),
      brand: clean(cells[2]),
      representative: clean(cells[3]),
      registration_no: clean(cells[4]),
      first_registered: clean(cells[5]),
      industry: clean(cells[6]),
      detail_url: link ? BASE + link[1] + encodeURIComponent(link[2]) : '',
    });
  }
  return rows;
}

/** All result rows for one search term, following the pages (bounded). */
async function searchAll(term, started) {
  const first = await get(searchUrl(term, 1));
  if (first.res.status === 403 || first.res.status === 429) {
    return { blocked: `HTTP ${first.res.status}`, url: searchUrl(term, 1) };
  }
  if (!first.res.ok) return { error: 'http_error', detail: `HTTP ${first.res.status}`, url: searchUrl(term, 1) };
  if (/\/login/i.test(first.res.url)) return { blocked: 'redirected to login', url: first.res.url };

  let rows = parseRows(first.text);
  if (rows === null) {
    if (/captcha|보안문자|접근이 제한|접속이 차단|access denied/i.test(first.text)) {
      return { blocked: 'bot or access check on page', url: searchUrl(term, 1) };
    }
    if (first.text.includes('등록된 목록이 없습니다')) return { rows: [], url: searchUrl(term, 1) };
    return { error: 'layout_changed', detail: first.text.slice(0, 300), url: searchUrl(term, 1) };
  }

  let html = first.text;
  let page = 1;
  while (html.includes(`pageIndex=${page + 1}"`)) {
    if (page >= MAX_PAGES || Date.now() - started > DEADLINE_MS) {
      return { error: 'other', detail: `more than ${page} result pages; not all checked`, url: searchUrl(term, 1) };
    }
    page += 1;
    const next = await get(searchUrl(term, page));
    if (!next.res.ok) return { error: 'http_error', detail: `HTTP ${next.res.status}`, url: searchUrl(term, page) };
    const more = parseRows(next.text);
    if (!more) return { error: 'layout_changed', detail: `page ${page} has no result table`, url: searchUrl(term, page) };
    rows = rows.concat(more);
    html = next.text;
  }
  return { rows, url: searchUrl(term, 1) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const name = core(keyword);
    const wanted = normalize(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + LIST, excerpt: 'no company name in the keyword' };
    }

    // The site matches a part of the name. Try the name as typed (legal form removed), then without spaces.
    const terms = [...new Set([name, name.replace(/\s+/g, '')])].filter(Boolean);
    const similar = new Set();
    let lastUrl = searchUrl(name, 1);

    for (const term of terms) {
      const r = await searchAll(term, started);
      lastUrl = r.url;
      if (r.blocked) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: r.url, excerpt: r.blocked };
      }
      if (r.error) {
        return { status: 'couldnt_check', reason: r.error, records: [], source_url: r.url, excerpt: r.detail };
      }

      const matches = r.rows.filter((row) => normalize(row.name) === wanted);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches,
          source_url: r.url,
          excerpt: `${matches.length} registration(s) under 상호 "${matches[0].name}"`,
        };
      }
      r.rows.forEach((row) => similar.add(row.name));
    }

    const near = [...similar].slice(0, 5).join(' | ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: near ? `no 상호 equal to "${keyword}"; similar names on the site: ${near}` : `no 상호 matches "${keyword}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl(core(keyword), 1),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
