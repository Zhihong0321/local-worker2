export const meta = {
  task: 'CA-bdc.ca',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'portfolio_url'],
  canary: { found: 'Acerta', not_found: 'Société Fantôme Introuvable Ltée' },
};

// BDC Capital venture-capital portfolio list. The first page is rendered in the HTML, the rest come from the
// "View more" endpoint, which only answers AJAX-style requests (X-Requested-With header). 373 companies on 32 pages
// when this was written (2026-11-13).
const SITE = 'https://www.bdc.ca';
const PAGE_URL = `${SITE}/en/bdc-capital/venture-capital/portfolio`;
const LIST_URL = `${SITE}/features/pages/landingpage/viewmorecompanies?pageLink=6918&language=en-CA`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 80;
const BATCH = 6; // pages fetched in parallel per round
const DEADLINE_MS = 30000; // no new batch starts after this; one batch can take at most 25 s more, so < 60 s total
const TILE = /<a title="([^"]+)" href="(\/en\/bdc-capital\/venture-capital\/portfolio\/[^"?#]*)"/g;
// Legal-form words dropped before comparing, so "Acerta Inc." and "ACERTA" compare equal.
const LEGAL_WORDS = new Set(['inc', 'incorporated', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'llc', 'lp', 'ulc', 'ltee', 'sa', 'plc', 'gmbh', 'sdn', 'bhd', 'the']);

function normalize(str) {
  return String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL_WORDS.has(t))
    .join('');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function parseTiles(html) {
  const out = [];
  for (const m of html.matchAll(TILE)) out.push({ name: decodeEntities(m[1]).trim(), path: m[2] });
  return out;
}

async function fetchPage(page) {
  const qs = new URLSearchParams({
    pageNumber: String(page), filterCompanyBy: 'Region', fundId: '', industrySector: 'ALL', regionExit: 'ALL', isManagement: 'false',
  });
  const url = `${LIST_URL}&${qs.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html, */*; q=0.01' },
      signal: AbortSignal.timeout(25000),
    });
    const html = res.status === 200 ? await res.text() : '';
    return { page, status: res.status, html, url };
  } catch (error) {
    return { page, error };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const couldnt = (reason, excerpt, source_url = PAGE_URL) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });
  try {
    const wanted = normalize(keyword);
    if (!wanted) return couldnt('other', 'the company name has no letters or digits');

    let checked = 0;
    let listEnded = false;
    for (let first = 1; first <= MAX_PAGES && !listEnded; first += BATCH) {
      if (Date.now() - started > DEADLINE_MS) return couldnt('timeout', `stopped after ${checked} companies: the list check ran past ${DEADLINE_MS / 1000} s`);
      const pages = [];
      for (let p = first; p < first + BATCH && p <= MAX_PAGES; p++) pages.push(p);
      const results = await Promise.all(pages.map((p) => fetchPage(p)));
      for (const r of results) {
        if (r.error) {
          const reason = r.error.name === 'TimeoutError' || r.error.name === 'AbortError' ? 'timeout' : 'other';
          return couldnt(reason, `page ${r.page}: ${String(r.error.message || r.error).slice(0, 200)}`);
        }
        if (r.status === 403 || r.status === 429) return couldnt('blocked', `HTTP ${r.status} on list page ${r.page}`, r.url);
        if (r.status !== 200) return couldnt('http_error', `HTTP ${r.status} on list page ${r.page}`, r.url);
        const tiles = parseTiles(r.html);
        if (tiles.length === 0) {
          if (r.page === 1) return couldnt('layout_changed', 'the portfolio list has no company tiles on page 1', r.url);
          listEnded = true; // a later empty page is the normal end of the list
          break;
        }
        checked += tiles.length;
        const hit = tiles.find((t) => normalize(t.name) === wanted);
        if (hit) {
          return {
            status: 'found',
            reason: '',
            records: [{ name: hit.name, portfolio_url: new URL(hit.path, SITE).href }],
            source_url: PAGE_URL,
            excerpt: `Listed on the BDC Capital venture-capital portfolio as "${hit.name}"`,
          };
        }
      }
    }
    if (!listEnded) return couldnt('other', `the list is longer than ${MAX_PAGES} pages; not all of it was checked`);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `No match among the ${checked} companies on the BDC Capital venture-capital portfolio list`,
    };
  } catch (err) {
    return couldnt('other', String(err?.message || err).slice(0, 300));
  }
}
