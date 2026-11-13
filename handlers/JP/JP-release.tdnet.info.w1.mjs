export const meta = { task: 'JP-release.tdnet.info', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['code', 'company_name', 'disclosed_at', 'title', 'pdf_url'],
  canary: { found: 'トヨタ自', not_found: '架空不存在商事株式会社' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.release.tdnet.info';
const SEARCH_PAGE = `${ORIGIN}/onsf/TDJFSearch/I_head`;
const SEARCH_POST = `${ORIGIN}/onsf/TDJFSearch/TDJFSearch`;

function fail(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

function decode(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

// Strip legal-form marks; NFKC turns （株） into (株) and full-width letters into ASCII.
function coreName(keyword) {
  return String(keyword || '').normalize('NFKC')
    .replace(/\(株\)|\(有\)|株式会社|有限会社|合同会社|合名会社|合資会社|相互会社/g, '')
    .replace(/\s+/g, '').trim();
}

function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・･.,\-‐–—()\[\]'’&]/g, '');
}

// TDnet shows short names: "トヨタ自" for トヨタ自動車. Accept an exact match, or a short name that starts the full typed name.
function matchesName(display, core) {
  const d = norm(display), c = norm(core);
  if (!d || !c) return false;
  if (d === c) return true;
  return d.length >= 3 && c.startsWith(d);
}

function parseRows(html) {
  const out = [];
  const rowRe = /<tr class="(?:odd|even)">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const time = row.match(/<td class="time"[^>]*>([\s\S]*?)<\/td>/);
    const code = row.match(/<td class="code"[^>]*>([\s\S]*?)<\/td>/);
    const company = row.match(/<td class="companyname"[^>]*>([\s\S]*?)<\/td>/);
    const title = row.match(/<td class="title"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!time || !code || !company || !title) continue;
    out.push({
      time: decode(time[1]),
      code: decode(code[1]),
      company: decode(company[1]),
      href: decode(title[1]),
      title: decode(title[2]),
    });
  }
  return out;
}

async function get(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', ...(init.headers || {}) },
    signal: AbortSignal.timeout(25000),
  });
}

function statusFail(res, url) {
  if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`, url);
  return fail('http_error', `HTTP ${res.status}`, url);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const core = coreName(keyword);
    if (!core) return fail('other', 'empty company name', SEARCH_POST);
    // TDnet lists companies by Japanese name only; a Latin-only name cannot be matched here.
    if (!/[぀-ヿ㐀-鿿]/.test(core)) {
      return fail('other', `TDnet lists companies by their Japanese name; "${core}" has no Japanese text, so it cannot be matched.`, SEARCH_POST);
    }

    // The search form only offers the last month of disclosures; read that window from the page.
    const page = await get(SEARCH_PAGE);
    if (!page.ok) return statusFail(page, SEARCH_PAGE);
    const pageHtml = await page.text();
    const sel = pageHtml.match(/<select name="t0"[\s\S]*?<\/select>/);
    const days = sel ? [...sel[0].matchAll(/value="(\d{8})"/g)].map((x) => x[1]) : [];
    if (!pageHtml.includes('name="search"') || days.length === 0) {
      return fail('layout_changed', pageHtml.slice(0, 300), SEARCH_PAGE);
    }
    const t0 = days.reduce((a, b) => (b < a ? b : a));
    const t1 = days.reduce((a, b) => (b > a ? b : a));

    const body = new URLSearchParams({ t0, t1, q: core, m: '0' });
    const res = await get(SEARCH_POST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': SEARCH_PAGE, 'Origin': ORIGIN },
      body: body.toString(),
    });
    if (!res.ok) return statusFail(res, SEARCH_POST);
    const html = await res.text();

    if (html.includes('該当する適時開示情報が見つかりませんでした')) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_POST,
        excerpt: `No TDnet disclosure matches "${core}" between ${t0} and ${t1} (TDnet keeps about one month).`,
      };
    }

    const rows = parseRows(html);
    if (rows.length === 0) return fail('layout_changed', decode(html).slice(0, 300), SEARCH_POST);

    const matched = rows.filter((r) => matchesName(r.company, core));
    if (matched.length === 0) {
      const seen = [...new Set(rows.map((r) => r.company))].slice(0, 5).join(', ');
      return fail('other', `TDnet returned ${rows.length} disclosure(s) for "${core}" but none from a company whose name matches. Names shown: ${seen}`, SEARCH_POST);
    }

    const records = matched.map((r) => ({
      code: r.code.slice(0, 4),
      company_name: r.company,
      disclosed_at: r.time,
      title: r.title,
      pdf_url: new URL(r.href, ORIGIN).href,
    }));
    const first = matched[0];
    return {
      status: 'found', reason: '', records, source_url: SEARCH_POST,
      excerpt: `${matched.length} TDnet disclosure(s) from ${first.company} (code ${first.code.slice(0, 4)}), ${t0}-${t1}. Latest ${first.time}: ${first.title}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err), SEARCH_POST);
  }
}
