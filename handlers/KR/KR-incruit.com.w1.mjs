export const meta = {
  task: 'KR-incruit.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'company_url', 'size', 'industry', 'address', 'ceo', 'founded', 'revenue', 'capital', 'employees', 'avg_salary'],
  canary: { found: '삼성전자', not_found: '가나다라마바사존재안함주식회사' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Korean and English legal-form words that are dropped before comparing names.
const LEGAL_FORMS = /주식회사|유한책임회사|유한회사|합자회사|합명회사|사단법인|재단법인|\(주\)|\(유\)|\(유한\)|\(사\)|\(재\)|\b(?:co\.?\s*,?\s*ltd|inc|corp|llc|ltd)\b\.?/gi;

function normalize(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LEGAL_FORMS, '')
    .replace(/[^0-9a-z가-힣]/g, '');
}

function text(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodePage(res, buf) {
  const ct = res.headers.get('content-type') || '';
  if (/utf-8/i.test(ct)) return new TextDecoder('utf-8').decode(buf);
  // The site serves EUC-KR (charset=euc-kr).
  return new TextDecoder('euc-kr').decode(buf);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const fallbackUrl = 'https://search.incruit.com/list/search.asp?col=company';
  try {
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: fallbackUrl, excerpt: 'empty company name' };
    }

    // Search on the core name (legal form and spaces removed); the match below is done on normalised names.
    const core = name.replace(LEGAL_FORMS, ' ').replace(/[\s,.]+/g, '') || name;
    const searchUrl = `https://search.incruit.com/list/search.asp?col=company&kw=${encodeURIComponent(core)}`;

    const res = await fetch(searchUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
      },
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (/login|captcha/i.test(res.url || '')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `redirected to ${res.url}`.slice(0, 300) };
    }

    const html = decodePage(res, await res.arrayBuffer());

    // Each company in the result list starts with this block.
    const blocks = html.split('<div class="cTtoal_company_header_wrap">').slice(1);
    const companies = [];
    for (const raw of blocks) {
      const seg = raw.split('<hr class="cSpaing">')[0];
      const head = seg.match(/<div class="cTtoal_company_header_context">\s*<span>\s*<a href="https:\/\/www\.incruit\.com\/company\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!head) continue;
      const c = {
        name: text(head[2]),
        company_id: head[1],
        company_url: `https://www.incruit.com/company/${head[1]}`,
      };
      const listBlock = seg.match(/<div class="cTtoal_company_sgrp_list">[\s\S]*?<\/div>/)?.[0] || '';
      const lis = (listBlock.match(/<li>[\s\S]*?<\/li>/g) || []).map(text);
      c.size = lis[0] || '';
      c.industry = lis[1] || '';
      c.address = lis[2] || '';
      for (const [, dt, dd] of seg.matchAll(/<dl class="cTtoal_company_sgrp_den[^"]*"><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/dl>/g)) {
        const k = text(dt);
        const v = text(dd);
        if (k === '설립일') c.founded = v;
        else if (k === '대표자명') c.ceo = v;
        else if (k === '매출액') c.revenue = v;
        else if (k === '자본금') c.capital = v;
        else if (k === '사원수') c.employees = v;
        else if (k === '평균연봉') c.avg_salary = v;
      }
      companies.push(c);
    }

    if (companies.length === 0) {
      if (!html.includes('cTtoal') && !html.includes('검색결과') && !html.includes('없습니다')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text(html).slice(0, 300) };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `The company search returned no company entries for "${name}"`,
      };
    }

    const want = normalize(name);
    const matches = want ? companies.filter((c) => normalize(c.name) === want) : [];

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${companies.length} companies listed, none named "${name}". First: ${companies.slice(0, 3).map((c) => c.name).join(', ')}`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: searchUrl,
      excerpt: matches.map((c) => `${c.name} | CEO ${c.ceo || '-'} | founded ${c.founded || '-'} | ${c.address || '-'}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: fallbackUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
