export const meta = {
  task: 'KR-isms.kisa.or.kr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'grade', 'state', 'number', 'scope', 'validity'],
  canary: { found: '(주)세라젬', not_found: '세무법인 혜움' },
};

// KISA ISMS / ISMS-P certificate issue list (public, plain GET).
// The historical host isms.kisa.or.kr no longer resolves (NXDOMAIN); the live
// portal for the same list is https://isms-p.or.kr/sttus/cert/selectCrtfctIsueList.do
const BASE = 'https://isms-p.or.kr/sttus/cert/selectCrtfctIsueList.do';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|합자회사|합명회사/g, '')
    .replace(/[\s\-.,'"·&()\[\]{}]/g, '')
    .trim();
}

// Variants of the query to try when the plain name search comes back empty.
function variants(keyword) {
  const raw = String(keyword || '').trim();
  const out = [];
  const push = (v) => {
    const t = String(v || '').trim();
    if (!t) return;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  push(raw);
  push(raw.replace(/\(주\)|\(유\)|㈜|주식회사|유한회사/g, '').trim());
  push(raw.replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|주/g, '').trim());
  push(raw.replace(/[\s()]/g, ''));
  // longest Hangul/latin chunk of at least 2 chars
  const chunks = raw.split(/[^0-9A-Za-z가-힣]+/).filter((c) => c.length >= 2);
  chunks.sort((a, b) => b.length - a.length);
  for (const c of chunks) push(c);
  return out.slice(0, 4);
}

function countExcerpt(html) {
  const t = stripTags(html);
  const m = t.match(/전체\s*[\d,]+\s*건/);
  if (m && m.index !== undefined) return t.slice(m.index, m.index + 300);
  return t.slice(0, 300);
}

function parsePage(html) {
  // layout markers we depend on
  const hasTable = html.includes('certi_status_02_tb') && html.includes('class="tbody"');
  const hasHeader = html.includes('업체(기관)명') && html.includes('인증번호');
  if (!hasTable || !hasHeader) return { layoutOk: false };

  let total = null;
  const tm = html.match(/전체\s*<em>\s*([\d,]+)\s*<\/em>\s*건/);
  if (tm) total = Number(tm[1].replace(/,/g, ''));
  if (total === null) {
    const tm2 = html.match(/전체\s*([\d,]+)\s*건/);
    if (tm2) total = Number(tm2[1].replace(/,/g, ''));
  }

  const tbody = html.slice(html.indexOf('class="tbody"'));
  const records = [];
  const blocks = tbody.split('class="tr_group"').slice(1);
  for (const b of blocks) {
    const end = b.indexOf('class="tr_group"');
    const block = end >= 0 ? b.slice(0, end) : b;
    const field = (cls) => {
      const re = new RegExp('class="td ' + cls + '[^"]*"[\\s\\S]*?<div class="cont[^"]*">([\\s\\S]*?)<\\/div>');
      const m = block.match(re);
      return m ? stripTags(m[1]) : '';
    };
    const name = field('comp_name');
    if (!name) continue;
    records.push({
      name,
      number: field('auth_number'),
      scope: field('auth_range'),
      validity: field('validity'),
      state: field('maint_status'),
    });
  }
  return { layoutOk: true, total, records };
}

async function fetchPage(keyword, page, option) {
  const url =
    BASE +
    '?searchOption=' + option +
    '&searchYear=' +
    '&searchKeyword=' + encodeURIComponent(keyword) +
    '&pageIndex=' + page;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { error: 'http_error', status: res.status, url };
    const html = await res.text();
    return { html, url };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timeout' : 'http_error', url };
  } finally {
    clearTimeout(timer);
  }
}

export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: '' };
    }

    let first = null;
    let usedKeyword = kw;
    let usedOption = 1;
    let rows = [];
    let total = 0;

    for (const cand of variants(kw)) {
      const r = await fetchPage(cand, 1, 1);
      if (r.error) {
        return {
          status: 'couldnt_check',
          reason: r.error,
          records: [],
          source_url: r.url || BASE,
          excerpt: r.status ? 'HTTP ' + r.status : '',
        };
      }
      const p = parsePage(r.html);
      if (!p.layoutOk) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: r.url,
          excerpt: stripTags(r.html).slice(0, 400),
        };
      }
      first = first || { url: r.url, html: r.html };
      if (p.total && p.total > 0) {
        rows = p.records;
        total = p.total;
        usedKeyword = cand;
        break;
      }
      await sleep(1100);
    }

    if (!first) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: '' };
    }

    // paging: keep going only while the site reports more than one page
    const perPage = rows.length || 10;
    let page = 1;
    while (total > page * perPage && page < 5) {
      page += 1;
      await sleep(1100);
      const r = await fetchPage(usedKeyword, page, usedOption);
      if (r.error) break;
      const p = parsePage(r.html);
      if (!p.layoutOk) break;
      if (!p.records.length) break;
      rows = rows.concat(p.records);
      if (p.total) total = p.total;
    }

    if (!rows.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: first.url,
        excerpt: countExcerpt(first.html),
      };
    }

    // A record only counts as a match if every meaningful token of the queried
    // name appears in the certificate holder's name (token order ignored).
    const tokens = String(kw)
      .replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|합자회사|합명회사/g, ' ')
      .split(/[^0-9A-Za-z가-힣]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 1);
    const matched = rows.filter((rec) => {
      const rn = normName(rec.name);
      if (!rn) return false;
      if (!tokens.length) return false;
      return tokens.every((t) => rn.includes(t));
    });

    if (!matched.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: first.url,
        excerpt: countExcerpt(first.html),
      };
    }
    const out = matched;

    return {
      status: 'found',
      reason: '',
      records: out.slice(0, 20).map((r) => ({
        name: r.name,
        grade: r.number.startsWith('ISMS-P') ? 'ISMS-P' : 'ISMS',
        state: r.state,
        number: r.number,
        scope: r.scope,
        validity: r.validity,
      })),
      source_url: first.url,
      excerpt: out
        .slice(0, 3)
        .map((r) => `${r.name} / ${r.number} / ${r.scope} / ${r.validity} / ${r.state}`)
        .join('\n')
        .slice(0, 500),
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String((e && e.message) || e).slice(0, 200),
    };
  }
}
