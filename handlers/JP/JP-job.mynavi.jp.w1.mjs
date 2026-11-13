export const meta = {
  task: 'JP-job.mynavi.jp',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'corp_id', 'head_office_postal', 'head_office_address', 'head_office_phone', 'founded', 'capital', 'employees', 'sales', 'offices', 'group_companies', 'url'],
  canary: { found: '北海道ガス(株)【北ガス】', not_found: '架空商事株式会社' },
};

const BASE = 'https://job.mynavi.jp';
const SEARCH_PAGE = `${BASE}/27/pc/corpinfo/displayCorpSearch/index?tab=corp`;
const SEARCH_POST = `${BASE}/27/pc/corpinfo/searchCorpListByGenCond/index`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;          // the site shows at most 100 companies per results page
const OUTLINE_DEADLINE_MS = 30000; // do not start a detail-page fetch after this (the whole call must end under 60 s)

// Legal-form words and marks that the site writes in some names but not others.
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|\(株\)|\(有\)|\(同\)|\(合\)|co\.?,?\s*ltd\.?|inc\.?|corp\.?|limited|ltd\.?/gi;

/** Search text: full width folded, 【…】 notes, former-name notes (旧社名…) and legal form removed. */
function searchTerm(keyword) {
  return String(keyword || '').normalize('NFKC')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\((?:[^()]|\([^()]*\))*\)/g, (m) => (m.includes('旧') ? ' ' : m))
    .replace(LEGAL_FORMS, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Comparison key: searchTerm plus no spaces or dot/dash punctuation, lower case. */
function core(str) {
  return searchTerm(str).toLowerCase().replace(/[\s・.,、。\-_'"’]/g, '');
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function text(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ' / ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company list entries on a results page: { id, name }. */
function parseEntries(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*\bid="corpNameLink\[\d+\]"[^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = m[1].match(/href="\/27\/pc\/search\/corp(\d+)\/outline\.html"/);
    if (!href || seen.has(href[1])) continue;
    seen.add(href[1]);
    out.push({ id: href[1], name: text(m[2]) });
  }
  return out;
}

const DETAIL_LABELS = {
  '本社郵便番号': 'head_office_postal',
  '本社所在地': 'head_office_address',
  '本社電話番号': 'head_office_phone',
  '設立': 'founded',
  '資本金': 'capital',
  '従業員': 'employees',
  '売上高': 'sales',
  '事業所': 'offices',
  'グループ会社': 'group_companies',
};

/** Parse one company outline page (public, no login) into the detail fields. */
function parseOutline(html, fallbackName, url) {
  const rec = { name: fallbackName, corp_id: '', url };
  for (const k of Object.values(DETAIL_LABELS)) rec[k] = '';
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (h1 && text(h1[1])) rec.name = text(h1[1]);
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const key = DETAIL_LABELS[text(m[1])];
    if (key && !rec[key]) rec[key] = text(m[2]);
  }
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const jar = new Map();
  const wanted = core(keyword);
  const term = searchTerm(keyword);

  const fail = (reason, excerpt, source_url) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) });

  // One fetch with the cookie jar kept between calls (the search needs the session cookie from the first page).
  const send = async (url, init = {}) => {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
      ...(init.headers || {}),
    };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') || ''];
    for (const c of cookies) {
      const kv = String(c).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };

  try {
    if (!wanted) return fail('other', 'the company name is empty after removing legal form and notes', SEARCH_PAGE);

    // Step 1: the search page gives the session cookie, the _csrf token and the _vs token.
    const pageRes = await send(SEARCH_PAGE);
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', `HTTP ${pageRes.status} on search page`, SEARCH_PAGE);
    if (!pageRes.ok) return fail('http_error', `HTTP ${pageRes.status} on search page`, SEARCH_PAGE);
    const pageHtml = await pageRes.text();
    if (/displayForLogin/.test(pageRes.url) || /captcha/i.test(pageHtml.slice(0, 20000))) {
      return fail('blocked', 'login or captcha page on search page', SEARCH_PAGE);
    }
    const csrf = pageHtml.match(/name="_csrf" value="([^"]+)"/);
    const vs = pageHtml.match(/name="_vs" value="([^"]+)"/);
    if (!csrf || !vs) return fail('layout_changed', 'search page has no _csrf/_vs token: ' + text(pageHtml).slice(0, 200), SEARCH_PAGE);

    // Step 2: free-word search restricted to the company name (srchWordTgt=0), as the site's own form sends it.
    const body = new URLSearchParams({
      srchWord: term,
      srchWordTgt: '0',
      actionMode: 'searchFw',
      nextUrl: '/corpinfo/displayCorpSearch/index',
      _csrf: csrf[1],
      _vs: vs[1],
    });
    const res = await send(SEARCH_POST, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': SEARCH_PAGE, 'Origin': BASE },
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status} on search`, SEARCH_POST);
    if (!res.ok) return fail('http_error', `HTTP ${res.status} on search`, SEARCH_POST);
    const html = await res.text();
    if (/captcha/i.test(html.slice(0, 20000))) return fail('blocked', 'captcha on search results', SEARCH_POST);
    if (html.includes('ただいまこの操作は利用できません')) {
      return fail('other', 'site showed its "operation unavailable" error page for the search', SEARCH_POST);
    }

    const entries = parseEntries(html);
    const searchedText = `srchWord=${term} srchWordTgt=0`;
    if (entries.length === 0) {
      if (html.includes('該当する企業はありませんでした')) {
        return {
          status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE,
          excerpt: `Mynavi search (company name only, ${searchedText}) returned 0 companies`,
        };
      }
      return fail('layout_changed', 'search results page has no company list and no "no result" text: ' + text(html).slice(0, 200), SEARCH_POST);
    }

    // Step 3: keep only the companies whose normalised name equals the typed name.
    const matches = entries.filter((e) => core(e.name) === wanted);
    if (matches.length === 0) {
      if (entries.length >= PAGE_SIZE) {
        return fail('other', `the name search returned ${PAGE_SIZE}+ companies and none on the first page has this exact name; the site pages its results and this handler reads only the first page`, SEARCH_POST);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE,
        excerpt: `Mynavi search (company name only, ${searchedText}) returned ${entries.length} companies, none with this name: ${entries.slice(0, 5).map((e) => e.name).join(' | ')}`.slice(0, 500),
      };
    }

    // Step 4: read the public company outline page for each exact match (in time budget).
    const records = [];
    for (const m of matches.slice(0, 3)) {
      const url = `${BASE}/27/pc/search/corp${m.id}/outline.html`;
      if (Date.now() - started > OUTLINE_DEADLINE_MS) {
        records.push({ name: m.name, corp_id: m.id, url, head_office_postal: '', head_office_address: '', head_office_phone: '', founded: '', capital: '', employees: '', sales: '', offices: '', group_companies: '' });
        continue;
      }
      let rec;
      try {
        const det = await send(url);
        rec = det.ok ? parseOutline(await det.text(), m.name, url) : { name: m.name, corp_id: '', url };
      } catch {
        rec = { name: m.name, corp_id: '', url };
      }
      rec.corp_id = m.id;
      for (const k of Object.values(DETAIL_LABELS)) if (rec[k] === undefined) rec[k] = '';
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.url,
      excerpt: `${first.name} | ${first.head_office_address || 'address not shown'} | ${first.founded || ''}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err), SEARCH_POST);
  }
}
