export const meta = {
  task: 'TW-tw.ttnet.net',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_url', 'main_products', 'description'],
  canary: { found: '竑高企業有限公司', not_found: '䨽竗鬄饕股份有限公司' },
};

const BASE = 'https://tw.ttnet.net';
const SEARCH = BASE + '/comporsearch/compors';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // the search is fuzzy (20 per page); scan at most this many pages
const TIME_BUDGET_MS = 30000; // do not start a new page after this, so the call stays under 60 s
const LEGAL_SUFFIXES = ['股份有限公司', '有限责任公司', '有限責任公司', '有限公司', '股份有限', '公司'];

/** Name used for comparison: NFKC, lower case, no spaces or punctuation, no trailing legal form. */
function core(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(/[\s　,，.。、·・&()（）\[\]【】\-—_'"“”‘’/\\]/g, '');
  for (const suf of LEGAL_SUFFIXES) {
    if (t.length > suf.length && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrl(keyword, page) {
  return `${SEARCH}?find=${encodeURIComponent(keyword)}` + (page > 1 ? `&flag=null&currentPage=${page}` : '');
}

/** One result block per company in the search list. */
function parseItems(html) {
  const out = [];
  for (const block of html.split('<li class="com-item">').slice(1)) {
    const nm = block.match(/<div class="c-name">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!nm) continue;
    const des = block.match(/<div class="c-des"[^>]*>([\s\S]*?)<\/div>/);
    const pro = block.match(/<dt>主要產品[：:]<\/dt>\s*<dd>([\s\S]*?)<\/dd>/);
    out.push({
      name: decode(nm[2]),
      company_url: new URL(nm[1].replace(/&amp;/gi, '&'), BASE).href,
      main_products: pro ? decode(pro[1]) : '',
      description: des ? decode(des[1]).slice(0, 400) : '',
    });
  }
  return out;
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** Like a browser visit: load the home page once and keep its session cookies for the search. Failure is not fatal. */
async function sessionCookie() {
  try {
    const res = await fetch(BASE + '/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    await res.arrayBuffer().catch(() => {});
    return cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {
    return '';
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  const firstUrl = searchUrl(name, 1);
  try {
    const want = core(name);
    if (!want) return fail('other', firstUrl, 'the company name has no usable characters');

    const cookie = await sessionCookie();
    const matches = [];
    let totalPages = 1;
    let scanned = 0;
    let lastUrl = firstUrl;
    let lastExcerpt = '';

    for (let page = 1; page <= Math.min(MAX_PAGES, totalPages); page++) {
      if (page > 1 && Date.now() - started > TIME_BUDGET_MS) break;
      const url = searchUrl(name, page);
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
          ...(cookie ? { 'Cookie': cookie } : {}),
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);
      if (String(res.url).includes('/ttnet/csrf')) return fail('blocked', url, 'redirected to the bot-check page /ttnet/csrf');

      const html = await res.text();
      if (/captcha/i.test(html)) return fail('blocked', url, 'captcha page');
      if (!html.includes('searchyCent')) return fail('layout_changed', url, decode(html).slice(0, 300));

      if (page === 1) {
        const pages = [...html.matchAll(/currentPage=(\d+)/g)].map((m) => Number(m[1]));
        totalPages = Math.max(1, ...pages);
      }
      scanned = page;
      lastUrl = url;

      for (const it of parseItems(html)) {
        if (core(it.name) === want) {
          matches.push({ name: it.name, company_url: it.company_url, main_products: it.main_products, description: it.description });
          lastExcerpt = `${it.name} | ${it.main_products}`;
        }
      }
      if (matches.length) break;
      lastExcerpt = decode(html).slice(0, 300);
    }

    if (matches.length) {
      return { status: 'found', reason: '', records: matches, source_url: lastUrl, excerpt: lastExcerpt.slice(0, 500) };
    }
    if (scanned >= totalPages) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `search for "${name}": ${totalPages} result page(s), no company named "${name}"`,
      };
    }
    return fail('other', firstUrl,
      `no exact name match in the first ${scanned} of ${totalPages} result pages; the search is too broad to prove absence`);
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return fail(reason, firstUrl, String(err?.message || err));
  }
}
