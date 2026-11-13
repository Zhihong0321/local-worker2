export const meta = { task: 'NZ-charities.govt.nz', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'legal_name', 'registration_number', 'status', 'registered_date', 'nzbn', 'officers', 'detail_url'],
  canary: { found: 'Can Do Kiwis', not_found: 'Te Whare Ātaahua o Te Kōrero Kore' } };

// Charities Services Register search: a plain GET, no token, no login. Each result row links to a charity page.
// The register search matches the legal name; a row can show another name, so a legal-name check is done too.
const SEARCH = 'https://register.charities.govt.nz/CharitiesRegister/Search';
const VIEW = 'https://register.charities.govt.nz/CharitiesRegister/ViewCharity';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-NZ,en;q=0.9' };
const PER_PAGE = 10;
const MAX_PAGES = 8;
const LATE_MS = 30000; // after this, no more reads: the whole call must end under 60 s
const LEGAL = new Set(['incorporated', 'inc', 'limited', 'ltd', 'company', 'co']);
const NOTE = 'The register search can miss a charity that is shown under another name.';

/** Lower case, macrons and accents removed, punctuation removed. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
/** Name with legal-form words removed, no spaces: the key two names are compared by. */
function key(s) {
  return fold(s).split(' ').filter((w) => w && !LEGAL.has(w)).join('');
}
function decode(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
function text(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}
function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}
function searchUrl(term, page) {
  const p = new URLSearchParams({
    Submitted: 'True', CharityNameSearchType: 'Contains', CharityName: term, RegistrationNumber: '', NZBNNumber: '',
    AddressLine1: '', AddressLine2: '', Suburb: '', TownCity: '', Postcode: '', Sector: '0', Activities: '0',
    Beneficiaries: '0', AreaOfOperation: '0', OfficerSearchType: '', FirstName: '', LastName: '',
    BodyCorporateNameSearchType: 'Begin', BodyCorporateName: '',
  });
  if (page > 1) p.set('DisplayPage', String(page));
  return SEARCH + '?' + p.toString();
}
async function get(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  return { status: res.status, html: await res.text() };
}
function resultCount(html) {
  const m = html.match(/<span class="bold">(\d+)<\/span>\s*results/);
  return m ? Number(m[1]) : null;
}
function parseRows(html) {
  const rows = [];
  const re = /<tr class="TableHighlight" data-charity-id="([^"]+)">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]));
    if (cells.length >= 4) {
      rows.push({ charity_id: m[1], name: cells[0], registration_number: cells[1], status: cells[2], registered_date: cells[3] });
    }
  }
  return rows;
}
function labelled(html, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp('<label[^>]*>\\s*' + esc + '\\s*</label>\\s*</div>\\s*<div[^>]*>\\s*<span[^>]*>([\\s\\S]*?)</span>', 'i'));
  return m ? text(m[1]) : '';
}
function officers(html) {
  const i = html.indexOf('id="officerDetailsTab"');
  if (i < 0) return null;
  const end = html.indexOf('class="tab-pane"', i + 10);
  const sec = html.slice(i, end > i ? end : i + 20000);
  const tb = sec.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tb) return [];
  return [...tb[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1])))
    .filter((c) => c.length >= 2)
    .map((c) => ({ name: c[0], position: c[1], effective_date: c[2] || '' }));
}
function isBotPage(html) {
  return /access denied|unusual traffic|are you a robot|cf-chl|challenge-platform|verify you are human/i.test(html);
}
async function readDetail(r) {
  const detail_url = VIEW + '?accountId=' + encodeURIComponent(r.charity_id);
  try {
    const d = await get(detail_url);
    if (d.status !== 200) return { ok: false, reason: d.status === 403 || d.status === 429 ? 'blocked' : 'http_error', detail_url, excerpt: 'HTTP ' + d.status };
    return { ok: true, detail_url, html: d.html };
  } catch (e) {
    return { ok: false, reason: errReason(e), detail_url, excerpt: String(e && e.message ? e.message : e) };
  }
}
function build(r, rd) {
  const rec = { name: r.name, legal_name: '', other_names: '', registration_number: r.registration_number, status: r.status,
    registered_date: r.registered_date, nzbn: '', officers: [], detail_url: VIEW + '?accountId=' + encodeURIComponent(r.charity_id) };
  if (!rd) return { ...rec, detail_note: 'detail page not read: time budget' };
  if (!rd.ok) return { ...rec, detail_note: 'detail page not read: ' + rd.reason };
  return { ...rec, legal_name: labelled(rd.html, 'Legal name of the Charity:') || r.name,
    other_names: labelled(rd.html, 'Other Name (inc Trading Name):'),
    nzbn: labelled(rd.html, 'NZBN number:'), status: labelled(rd.html, 'Current Status:') || r.status,
    officers: officers(rd.html) || [] };
}
function notFound(url, term, n) {
  return { status: 'not_found', reason: '', records: [], source_url: url,
    excerpt: `Register returned ${n} result(s) for "${term}", none with this name. ${NOTE}` };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let url1 = SEARCH;
  try {
    const term = String(keyword || '').replace(/\s+/g, ' ').trim();
    const want = key(term);
    if (!want) return fail('other', url1, 'empty company name');
    // Search on the name without its legal-form words ("X Incorporated" also finds "X").
    const coreTerm = term.split(' ').filter((w) => !LEGAL.has(fold(w))).join(' ');
    if (coreTerm.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return fail('other', url1, 'name too short for the register (needs 3 characters)');

    url1 = searchUrl(coreTerm, 1);
    const first = await get(url1);
    if (first.status === 403 || first.status === 429) return fail('blocked', url1, 'HTTP ' + first.status);
    if (first.status !== 200) return fail('http_error', url1, 'HTTP ' + first.status);
    if (!/table-clickable/.test(first.html)) {
      if (/No results have been found/i.test(first.html)) return notFound(url1, coreTerm, 0);
      if (isBotPage(first.html)) return fail('blocked', url1, 'bot check page');
      return fail('layout_changed', url1, first.html.slice(0, 300));
    }

    const count = resultCount(first.html);
    if (count === null) return fail('layout_changed', url1, 'results table without a result count');
    const pages = Math.ceil(count / PER_PAGE);
    if (pages > MAX_PAGES) {
      return fail('other', url1, `${count} register results for "${coreTerm}": too many to check every page`);
    }

    let rows = parseRows(first.html);
    const later = [];
    for (let p = 2; p <= pages; p++) later.push(p);
    const more = await Promise.all(later.map((p) => get(searchUrl(coreTerm, p)).then((r) => ({ p, r }))));
    for (const { p, r } of more) {
      const pUrl = searchUrl(coreTerm, p);
      if (r.status === 403 || r.status === 429) return fail('blocked', pUrl, 'HTTP ' + r.status);
      if (r.status !== 200 || !/table-clickable/.test(r.html)) return fail('layout_changed', pUrl, 'results page ' + p + ' not as expected');
      rows = rows.concat(parseRows(r.html));
    }
    if (rows.length !== count) return fail('layout_changed', url1, `read ${rows.length} rows, register says ${count}`);

    const byName = rows.filter((r) => key(r.name) === want);
    // Legal-name check: only when the names shown do not match and every result is on this page.
    const legalCheck = byName.length === 0;
    if (legalCheck && rows.length > PER_PAGE) {
      return fail('other', url1, `${count} register results for "${coreTerm}" and none shows this name; legal names not checked past ${PER_PAGE} results`);
    }
    const toRead = legalCheck ? rows : byName;
    const readable = Date.now() - started < LATE_MS;
    const reads = readable ? await Promise.all(toRead.map(readDetail)) : toRead.map(() => null);
    if (legalCheck && !readable) return fail('timeout', url1, 'time budget spent before legal names could be read');
    if (legalCheck) {
      const bad = reads.find((x) => !x.ok);
      if (bad) return fail(bad.reason, bad.detail_url, bad.excerpt);
    }

    const built = toRead.map((r, i) => build(r, reads[i]));
    const hits = legalCheck ? built.filter((b) => key(b.legal_name) === want || key(b.other_names) === want) : built;
    if (hits.length === 0) return notFound(url1, coreTerm, rows.length);

    return {
      status: 'found',
      reason: '',
      records: hits,
      source_url: hits[0].detail_url,
      excerpt: hits.map((r) => `${r.name} | ${r.registration_number} | ${r.status} | registered ${r.registered_date}`).join('; ').slice(0, 500),
    };
  } catch (e) {
    return fail(errReason(e), url1, String(e && e.message ? e.message : e));
  }
}
