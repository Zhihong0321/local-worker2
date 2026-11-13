export const meta = {
  task: 'DE-eqs-news.com',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'isin', 'page_url'],
  canary: { found: 'Allianz SE', not_found: 'Nichtexistierende Testfirma GmbH' },
};

const BASE = 'https://www.eqs-news.com/search-results/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 25;          // the site lists 25 companies per page
const MAX_PAGES = 10;          // at most 250 results are read
const NEW_PAGE_DEADLINE_MS = 30000; // do not start another page after 30 s (keeps the call under 60 s)

// Legal-form words, removed on both sides before two names are compared.
const LEGAL_FORMS = new Set([
  'gmbh', 'mbh', 'ag', 'se', 'kgaa', 'kg', 'ohg', 'ug', 'co', 'ev', 'eg',
  'aktiengesellschaft', 'kommanditgesellschaft', 'ltd', 'limited', 'inc', 'plc', 'llc',
  'sa', 'nv', 'bv', 'spa', 'srl', 'oyj',
]);

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Lowercase, umlauts spelled out, accents dropped, punctuation and legal form removed. */
function normName(s) {
  return decode(s)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

/** The search text: the company name without its legal form (the site search is word based). */
function searchTerm(name) {
  const words = name.split(' ').filter((w) => normName(w) !== '');
  return words.length ? words.join(' ') : name;
}

function pageUrl(term, page) {
  const q = `searchtype=company&searchword=${encodeURIComponent(term)}`;
  return page === 1 ? `${BASE}?${q}` : `${BASE}page/${page}/?${q}`;
}

async function getPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,de;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: { reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) } };
  }
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
  try {
    return { html: await res.text() };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: { reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) } };
  }
}

/** Reads one results page. Returns null when the page is neither a result list nor the empty message. */
function parsePage(html) {
  const count = html.replace(/&nbsp;/g, ' ').match(/Showing\s+\d+\s*-\s*\d+\s+out of\s+(\d+)\s+results/i);
  const empty = /No companies found/i.test(html);
  const rows = [];
  const re = /<a href="(https:\/\/www\.eqs-news\.com\/company\/[^"]+)" class="row[^"]*search-news__list"[\s\S]*?<p class="news__company news__company--search-result">([\s\S]*?)<\/p>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const isin = m[3].match(/data-company-isin="([A-Z]{2}[A-Z0-9]{10})"/);
    rows.push({ name: decode(m[2]).replace(/<[^>]+>/g, '').trim(), page_url: m[1], isin: isin ? isin[1] : '' });
  }
  if (!count && !empty && rows.length === 0) return null;
  if (count && rows.length === 0) return null; // the site says results exist but none could be read
  return { total: count ? Number(count[1]) : (empty ? 0 : null), rows };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startedAt = Date.now();
  try {
    const name = String(keyword || '').trim().replace(/\s+/g, ' ');
    const target = normName(name);
    if (!name || !target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name given' };
    }
    const term = searchTerm(name);
    const firstUrl = pageUrl(term, 1);

    const first = await getPage(firstUrl);
    if (first.fail) return { status: 'couldnt_check', ...first.fail, records: [], source_url: firstUrl };

    const p1 = parsePage(first.html);
    if (!p1) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl, excerpt: first.html.slice(0, 300) };
    }

    const all = [...p1.rows];
    const pages = p1.total ? Math.ceil(p1.total / PAGE_SIZE) : 1;
    let failure = null;
    let skipped = 0;
    for (let p = 2; p <= pages; p++) {
      if (p > MAX_PAGES || Date.now() - startedAt > NEW_PAGE_DEADLINE_MS) { skipped = pages - p + 1; break; }
      const pg = await getPage(pageUrl(term, p));
      if (pg.fail) { failure = pg.fail; break; }
      const parsed = parsePage(pg.html);
      if (!parsed) { failure = { reason: 'layout_changed', excerpt: pg.html.slice(0, 300) }; break; }
      all.push(...parsed.rows);
    }

    const seen = new Set();
    const matches = all.filter((r) => {
      if (seen.has(r.page_url) || normName(r.name) !== target) return false;
      seen.add(r.page_url);
      return true;
    });

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({ name: r.name, isin: r.isin, page_url: r.page_url })),
        source_url: firstUrl,
        excerpt: `${matches.length} listed match(es) for "${name}" on the company search (${all.length} result(s) read)`,
      };
    }
    if (failure) {
      return { status: 'couldnt_check', reason: failure.reason, records: [], source_url: firstUrl, excerpt: failure.excerpt || '' };
    }
    if (skipped) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
        excerpt: `search "${term}" has ${p1.total} results; only ${all.length} were read, the rest were not checked`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: p1.total === 0
        ? `No companies found for the provided search ("${term}")`
        : `${all.length} company result(s) for "${term}", none named "${name}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
