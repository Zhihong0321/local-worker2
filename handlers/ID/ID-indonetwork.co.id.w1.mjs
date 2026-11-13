export const meta = {
  task: 'ID-indonetwork.co.id',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'description', 'profile_url', 'company_id'],
  canary: { found: 'Cahaya Packing', not_found: 'PT Tidak Terdaftar Sejahtera Makmur Abadi' },
};

const BASE = 'https://www.indonetwork.co.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // 30 companies per page; exact names are normally on page 1
const TIME_BUDGET_MS = 40000; // stay well inside the 60 s limit
const LEGAL = new Set(['pt', 'cv', 'ud', 'pd', 'tbk', 'persero', 'perseroan', 'terbatas', 'firma', 'perum', 'ltd']);

function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare names: case, punctuation, spacing and legal form (PT / CV / UD ...) do not count. */
function normName(s) {
  let joined = decode(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && !LEGAL.has(t)).join('');
  // "PTATHENA" written without a space: drop a legal-form prefix when a real name follows it.
  const m = joined.match(/^(pt|cv|ud|pd|tbk|persero|perseroan|firma|perum)(.{3,})$/);
  if (m) joined = m[2];
  return joined;
}

/** The search ranks differently with a legal form in the query, so search the core name first. */
function coreQuery(keyword) {
  const toks = keyword.trim().split(/\s+/).filter((t) => !/^(pt|cv|ud|pd|tbk|persero|perseroan|firma|perum|ltd)\.?$/i.test(t));
  return (toks.join(' ') || keyword.trim()).slice(0, 100);
}

function searchUrl(query, page) {
  const u = new URL('/search', BASE);
  u.searchParams.set('type', 'perusahaan');
  u.searchParams.set('q', query);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function parseRows(html) {
  const chunks = html.split(/<li class="company-row"[^>]*>/).slice(1);
  const rows = [];
  for (const chunk of chunks) {
    const nameM = chunk.match(/<h3 class="company-row__name"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!nameM) continue;
    const addrM = chunk.match(/<p class="company-row__address"[^>]*>([\s\S]*?)<\/p>/);
    const descM = chunk.match(/<p class="company-row__description"[^>]*>([\s\S]*?)<\/p>/);
    const idM = chunk.match(/data-company-id="(\d+)"/);
    rows.push({
      name: decode(nameM[2]),
      profile_url: new URL(decode(nameM[1]), BASE).href,
      address: addrM ? decode(addrM[1]).replace(/^Alamat\s*/i, '') : '',
      description: descM ? decode(descM[1]).slice(0, 300) : '',
      company_id: idM ? idM[1] : '',
    });
  }
  return rows;
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/**
 * Walk the result pages of one search query.
 * Returns { kind: 'found', matches, url } | { kind: 'empty', url, count } | { kind: 'fail', result }.
 */
async function scan(query, want, started, state) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      return { kind: 'fail', result: fail('timeout', state.lastUrl, `stopped after ${page - 1} result pages to stay within 60 s`) };
    }
    const url = searchUrl(query, page);
    state.lastUrl = url;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'id,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { kind: 'fail', result: fail('blocked', url, `HTTP ${res.status}`) };
    if (!res.ok) return { kind: 'fail', result: fail('http_error', url, `HTTP ${res.status}`) };

    const html = await res.text();
    const rows = parseRows(html);
    const emptyText = html.includes('Tidak ada perusahaan yang ditemukan');
    const looksLikeSearch = html.includes('data-search-form') || html.includes('company-row') || emptyText;
    if (!looksLikeSearch) {
      // The site's contact form carries a captcha widget on every page, so only a page without search markers counts as a bot check.
      if (/cf-chl|Just a moment|Attention Required|verify you are human/i.test(html)) {
        return { kind: 'fail', result: fail('blocked', url, 'bot check page') };
      }
      return { kind: 'fail', result: fail('layout_changed', url, html.slice(0, 300)) };
    }
    if (page === 1 && rows.length === 0) {
      if (emptyText) return { kind: 'empty', url, count: 0 };
      return { kind: 'fail', result: fail('layout_changed', url, 'search page has no company rows and no empty-result text') };
    }

    const matches = rows.filter((r) => normName(r.name) === want);
    if (matches.length > 0) return { kind: 'found', matches, url };

    const hasNext = html.includes('in-pagination__next');
    if (!hasNext || rows.length === 0) return { kind: 'empty', url, count: rows.length };
  }
  return { kind: 'fail', result: fail('other', state.lastUrl, `name not on the first ${MAX_PAGES} result pages and more pages exist`) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const state = { lastUrl: searchUrl(keyword, 1) };
  try {
    const want = normName(keyword);
    if (!want) return fail('other', state.lastUrl, 'empty company name');

    // Core name first (no legal form), then the full keyword if it differs.
    const queries = [...new Set([coreQuery(keyword), keyword.trim().slice(0, 100)])];
    let lastEmpty = null;
    for (const q of queries) {
      const r = await scan(q, want, started, state);
      if (r.kind === 'fail') return r.result;
      if (r.kind === 'found') {
        const m = r.matches;
        return {
          status: 'found',
          reason: '',
          records: m.map((x) => ({ name: x.name, address: x.address, description: x.description,
            profile_url: x.profile_url, company_id: x.company_id })),
          source_url: r.url,
          excerpt: `${m[0].name} | ${m[0].address}`.slice(0, 500),
        };
      }
      lastEmpty = r;
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastEmpty.url,
      excerpt: lastEmpty.count === 0
        ? 'Tidak ada perusahaan yang ditemukan (search returned 0 companies)'
        : `Search returned ${lastEmpty.count} companies on the last page checked, none with this name`,
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return fail(reason, state.lastUrl, String(err?.message || err));
  }
}
