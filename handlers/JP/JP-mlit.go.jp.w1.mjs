export const meta = { task: 'JP-mlit.go.jp', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'registration_no', 'address', 'sanction_date', 'agency', 'sanction_type', 'sector', 'detail_url'],
  canary: { found: 'フレスコ建設株式会社', not_found: '架空テスト工業株式会社' } };

// The site is split by business sector. search.cgi needs a jigyoubunya code; without one it shows the menu page.
// These are the 23 sector codes linked from https://www.mlit.go.jp/nega-inf/ (bus, taxi, truck, travel and car-maker
// pages live on other MLIT sites and are not searched here).
const BASE = 'https://www.mlit.go.jp/nega-inf/cgi-bin/search.cgi';
const SECTORS = ['hosyou', 'hudousan', 'hudousangyousya', 'ikkyuu', 'jidousyaseibi', 'juutaku', 'kenchikuchosakensa',
  'kensetugyousya', 'kensetukonsaru', 'kentikukijun', 'koukuu', 'kouzoukeisan', 'mansyon', 'senpaku', 'shimeiteishi',
  'siteikakunin', 'siteikouzou', 'sokuryou', 'takuti', 'tetudou', 'tintai', 'tisitu', 'tourokujuutaku'];
// The name box has a different form field in the construction sector; every other sector uses jigyousya.
const NAME_FIELD = { kensetugyousya: 'disposal_name1' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;          // the site lists 10 rows per page
const MAX_PAGES = 8;           // per sector; more than this is reported as couldnt_check, never as not_found
const CONCURRENCY = 6;         // parallel sector searches
const START_BUDGET_MS = 25000; // no new request starts after this; each request has its own 25 s timeout
const REASON_ORDER = ['blocked', 'http_error', 'timeout', 'layout_changed', 'other'];
const LEGAL_FORM = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|特定非営利活動法人|学校法人|医療法人|宗教法人|独立行政法人/g;

/** Name text sent to the site (the site matches the name text as written). Legal-form words are removed. */
function searchTerm(keyword) {
  return String(keyword || '').normalize('NFC')
    .replace(/（株）|\(株\)|㈱/g, ' ').replace(LEGAL_FORM, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Normalised name for comparing: width, case, punctuation, spaces and legal form ignored. */
function norm(s) {
  return String(s || '').normalize('NFKC')
    .replace(/\((株|有|同|資|名|相)\)/g, '')
    .replace(LEGAL_FORM, '')
    .toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function searchUrl(sector, term, page) {
  const field = NAME_FIELD[sector] || 'jigyousya';
  return `${BASE}?jigyoubunya=${sector}&EID=search&${field}=${encodeURIComponent(term)}&reason_con=1`
    + (page > 1 ? `&page=${page}` : '');
}

/**
 * Rows of the result table. Column positions come from the header labels because the sectors differ
 * (some have an address column, some have no agency column, persons' sectors say 被処分者名).
 * Returns { rows } or { err: 'layout_changed', detail }.
 */
function parseRows(html) {
  const headerRow = html.match(/<tr[^>]*>(\s*<th[\s\S]*?)<\/tr>/);
  const labels = headerRow ? [...headerRow[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => cleanText(m[1])) : [];
  const idx = (re) => labels.findIndex((l) => re.test(l));
  const col = {
    name: idx(/^(商号又は名称|事業者名|被処分者名)$/),
    address: idx(/住所|所在地/),
    date: idx(/年月日/),
    agency: idx(/行った者|都道府県/),
    type: idx(/種類|^処分の内容$/),
  };
  if (col.name < 0) return { err: 'layout_changed', detail: `no name column in headers: ${labels.join(' | ')}` };

  const rows = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (!tds.length) continue; // header and "0 results" rows
    const cell = (i) => (i >= 0 && i < tds.length ? tds[i] : '');
    const nameHtml = cell(col.name);
    const reg = nameHtml.match(/（([0-9]+)）/);
    const link = tr[1].match(/<a class="overview" href="([^"]+)"/) || tr[1].match(/href="([^"]+)"/);
    rows.push({
      name: cleanText(nameHtml.replace(/<span[\s\S]*?<\/span>/g, '')),
      registration_no: reg ? reg[1] : '',
      address: cleanText(cell(col.address)),
      sanction_date: cleanText(cell(col.date)),
      agency: cleanText(cell(col.agency)),
      sanction_type: cleanText(cell(col.type)),
      detail_url: link ? new URL(link[1].replace(/&amp;/g, '&'), BASE).href : '',
    });
  }
  return { rows };
}

/** One result page. Returns { count, rows } or { err, detail }. Never throws. */
async function fetchPage(url, t0) {
  if (Date.now() - t0 > START_BUDGET_MS) return { err: 'timeout', detail: 'not started: time budget used up' };
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { err: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'other', detail: String(e?.message || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { err: 'blocked', detail: `HTTP ${res.status}` };
  if (!res.ok) return { err: 'http_error', detail: `HTTP ${res.status}` };
  let html;
  try { html = await res.text(); } catch (e) { return { err: 'other', detail: String(e?.message || e).slice(0, 200) }; }
  if (/captcha/i.test(html)) return { err: 'blocked', detail: 'bot check page' };
  const cm = html.match(/検索結果：\s*([0-9,]+)\s*件/);
  if (!cm) return { err: 'layout_changed', detail: cleanText(html).slice(0, 200) };
  const count = Number(cm[1].replace(/,/g, ''));
  if (!count) return { count, rows: [] };
  const parsed = parseRows(html);
  if (parsed.err) return { err: parsed.err, detail: parsed.detail };
  if (!parsed.rows.length) return { err: 'layout_changed', detail: 'result count shown but no rows parsed' };
  return { count, rows: parsed.rows };
}

/** All result pages of one sector. Never throws. */
async function searchSector(sector, term, t0) {
  const url1 = searchUrl(sector, term, 1);
  const out = { sector, url: url1, rows: [], err: '', detail: '', complete: true };
  const first = await fetchPage(url1, t0);
  if (first.err) return { ...out, err: first.err, detail: first.detail };
  out.rows.push(...first.rows);
  const pages = Math.ceil(first.count / PAGE_SIZE);
  if (pages > MAX_PAGES) out.complete = false;
  for (let page = 2; page <= Math.min(pages, MAX_PAGES); page++) {
    const p = await fetchPage(searchUrl(sector, term, page), t0);
    if (p.err) return { ...out, err: p.err, detail: p.detail };
    out.rows.push(...p.rows);
  }
  return out;
}

async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  try {
    const term = searchTerm(keyword);
    const kwNorm = norm(keyword);
    if (!term || kwNorm.length < 2) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
        excerpt: 'name too short to search after removing the legal form' };
    }

    const results = await runPool(SECTORS, CONCURRENCY, (s) => searchSector(s, term, t0));
    const records = [];
    for (const r of results) {
      for (const row of r.rows) {
        if (norm(row.name) === kwNorm) records.push({ ...row, sector: r.sector });
      }
    }
    const sectorList = [...new Set(records.map((r) => r.sector))].join(', ');
    const unread = results.filter((r) => r.err);

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: records[0].detail_url,
        excerpt: `${records.length} matching record(s) for "${term}" in ${sectorList}` + (unread.length ? `; ${unread.length} sector(s) could not be read` : '') };
    }

    if (unread.length) {
      const reason = REASON_ORDER.find((x) => unread.some((r) => r.err === x)) || 'other';
      const first = unread.find((r) => r.err === reason);
      return { status: 'couldnt_check', reason, records: [], source_url: first.url,
        excerpt: `${unread.length} of ${SECTORS.length} sectors could not be read: ${first.sector} ${first.err} ${first.detail}`.slice(0, 500) };
    }

    const incomplete = results.filter((r) => !r.complete);
    if (incomplete.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: incomplete[0].url,
        excerpt: `more than ${MAX_PAGES} result pages in ${incomplete.map((r) => r.sector).join(', ')}; not all read` };
    }

    return { status: 'not_found', reason: '', records: [], source_url: searchUrl(SECTORS[0], term, 1),
      excerpt: `0 matching records for "${term}" in ${SECTORS.length} sectors` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
