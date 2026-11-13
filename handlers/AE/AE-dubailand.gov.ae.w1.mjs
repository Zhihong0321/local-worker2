export const meta = { task: 'AE-dubailand.gov.ae', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'name_ar', 'office_number', 'office_issue_date', 'office_expiry_date', 'broker_cards'],
  canary: { found: 'HARBOR REAL ESTATE BROKER L.L.C', not_found: 'ZQXV NOTLISTED CANARY TRADING L.L.C' } };

// Dubai Land Department: Licensed Real Estate Brokers list (brokerage offices + broker cards).
// The public page calls a JSON gateway with the consumer id that the page itself ships to every visitor.
// This handler reads that id from the public page at run time (nothing is stored in this file) and makes
// the same anonymous GET the page makes. No login, no captcha, no paid access.
// Covers registered brokerage offices only (not licensed developers, projects or trakheesi permits).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_URL = 'https://dubailand.gov.ae/en/eservices/licensed-real-estate-brokers/licensed-real-estate-brokers-list';
const GATEWAY_URL = 'https://gateway.dubailand.gov.ae/brokers/';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;          // at most 2000 rows read per lookup
const BUDGET_MS = 40000;       // stay well inside the 60 s call limit
const LEGAL_LAST = ['llc', 'fzllc', 'fzco', 'fze', 'fz', 'ltd', 'limited', 'llp', 'pjsc'];

/** Lower case, unify punctuation, collapse spaces. */
function clean(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[.,\-_/&'’"()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Comparison key: cleaned name without a trailing legal form (L.L.C, LLC, FZ-LLC, FZCO, FZE, LTD, ...). */
function key(name) {
  let w = clean(name).split(' ').filter(Boolean);
  for (;;) {
    const n = w.length;
    if (n >= 3 && w[n - 3] === 'l' && w[n - 2] === 'l' && w[n - 1] === 'c') { w = w.slice(0, n - 3); continue; }
    if (n >= 1 && LEGAL_LAST.includes(w[n - 1])) { w = w.slice(0, n - 1); continue; }
    break;
  }
  return w.join('').replace(/[^\p{L}\p{N}]/gu, '');
}

/** The site's search is a substring match on the office name; the first word is the safest search term. */
function searchTerm(name) {
  return clean(name).split(' ').filter(Boolean)[0] || '';
}

function searchUrl(term) {
  return `${GATEWAY_URL}?sortCriteria=2&pageIndex=0&pageSize=${PAGE_SIZE}&officeName=${encodeURIComponent(term)}`;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

function fetchT(url, accept) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = typeof keyword === 'string' ? keyword.trim() : '';
  try {
    if (!key(input)) return fail('other', PAGE_URL, 'empty or unreadable company name');
    if (/[؀-ۿ]/.test(input)) {
      return fail('other', PAGE_URL, 'Arabic-script name: this site\'s brokerage-office search returns no rows for Arabic names, including names it lists, so an Arabic name cannot be checked here');
    }

    // 1. Public page: read the consumer id the page sends to every visitor.
    const pageRes = await fetchT(PAGE_URL, 'text/html,application/xhtml+xml,*/*;q=0.8');
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', PAGE_URL, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return fail('http_error', PAGE_URL, `HTTP ${pageRes.status}`);
    const pageHtml = await pageRes.text();
    const idMatch = pageHtml.match(/window\.apiConfig\s*=\s*\{[\s\S]*?"consumerId":"([A-Za-z0-9]+)"/);
    if (!idMatch) return fail('layout_changed', PAGE_URL, 'broker list page has no apiConfig consumer id');
    const consumerId = idMatch[1];

    // 2. Gateway search, page by page, until every row for the search term is read.
    const term = searchTerm(input);
    const rows = [];
    let total = 0;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > BUDGET_MS) return fail('timeout', searchUrl(term), 'time budget used before every result page was read');
      const url = `${GATEWAY_URL}?` + new URLSearchParams({
        'consumer-id': consumerId, sortCriteria: '2', pageIndex: String(page), pageSize: String(PAGE_SIZE), officeName: term,
      }).toString();
      const res = await fetchT(url, 'application/json');
      if (res.status === 401 || res.status === 403 || res.status === 429) return fail('blocked', searchUrl(term), `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', searchUrl(term), `HTTP ${res.status}`);

      let body;
      try { body = JSON.parse(await res.text()); } catch { return fail('layout_changed', searchUrl(term), 'search answer is not JSON'); }
      if (!body || typeof body !== 'object' || !('Response' in body)) return fail('layout_changed', searchUrl(term), 'search answer has no Response field');
      if (Array.isArray(body.Errors) && body.Errors.length) return fail('other', searchUrl(term), `site error: ${JSON.stringify(body.Errors).slice(0, 200)}`);

      const list = Array.isArray(body.Response) ? body.Response : [];
      total = list.length ? Number(list[0].TotalRowsCount) || 0 : Number(body.TotalRowsCount) || 0;
      rows.push(...list);
      if (list.length === 0 || (page + 1) * PAGE_SIZE >= total) { complete = true; break; }
    }

    // 3. Keep only offices whose name matches the company after normalising (case, punctuation, legal form).
    const target = key(input);
    const offices = new Map();
    for (const r of rows) {
      if (key(r.OfficeNameEn) !== target) continue;
      const id = `${r.RealEstateNumber || ''}|${r.OfficeNameEn}`;
      if (!offices.has(id)) {
        offices.set(id, {
          name: String(r.OfficeNameEn),
          name_ar: String(r.OfficeNameAr || ''),
          office_number: String(r.RealEstateNumber || ''),
          office_issue_date: String(r.OfficeIssueDate || '').slice(0, 10),
          office_expiry_date: String(r.OfficeExpiryDate || '').slice(0, 10),
          cards: new Set(),
        });
      }
      offices.get(id).cards.add(String(r.CardNumber || ''));
    }
    const records = [...offices.values()].map(o => ({
      name: o.name, name_ar: o.name_ar, office_number: o.office_number,
      office_issue_date: o.office_issue_date, office_expiry_date: o.office_expiry_date,
      broker_cards: o.cards.size,
    }));

    if (records.length) {
      const cards = records.reduce((n, r) => n + r.broker_cards, 0);
      return {
        status: 'found', reason: '', records, source_url: searchUrl(term),
        excerpt: `${records.length} brokerage office record(s) named "${records[0].name}" (${cards} broker cards) on the DLD licensed brokers list`,
      };
    }
    if (!complete) return fail('other', searchUrl(term), `too many rows for "${term}" to read every page (${total} rows)`);
    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl(term),
      excerpt: `0 brokerage offices named "${input}" among ${total} rows for "${term}" on the DLD licensed brokers list (offices only)`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', PAGE_URL, String(err?.message || err));
  }
}
