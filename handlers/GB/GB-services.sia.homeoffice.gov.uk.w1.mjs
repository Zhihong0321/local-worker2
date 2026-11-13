export const meta = { task: 'GB-services.sia.homeoffice.gov.uk', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'matched_on', 'acs_reference', 'activities', 'expiry', 'postal_address', 'contact', 'website', 'assessing_body', 'conditions', 'detail_url'],
  canary: { found: '1SC Guarding Limited', not_found: 'Qwerzxv Imaginary Holdings Ltd' } };

// The public register page with the complete list (one table, every approved contractor, with a detail link per row).
const LIST_URL = 'https://www.services.sia.homeoffice.gov.uk/Pages/acs-roac.aspx?all';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' };
// Legal-form words dropped from the end of a name before comparing (UK company forms).
const LEGAL = new Set(['limited', 'ltd', 'plc', 'llp', 'llc', 'lp', 'inc', 'co', 'company', 'corporation', 'corp', 'cic']);
// Labels on a contractor detail page, used to find where each value ends.
const LABELS = { acs_reference: 'ACS Reference Number', activities: 'Activities (Sectors) Approved', expiry: 'Expiry Date of Approval',
  contact: 'Contact Number', postal_address: 'Postal Address', website: 'Website', assessing_body: 'Assessing Body',
  conditions: 'Additional Conditions of Approval' };
const BOUNDS = ['ACS Reference Number', 'Activities (Sectors) Approved', 'Expiry Date of Approval', 'Contact Number', 'Postal Address',
  'Website', 'Assessing Body', 'Status', 'Additional Conditions of Approval', 'Other Services Provided', 'Search again', 'Modal Header'];

function decode(s) {
  return (s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

function cleanText(html) {
  return decode((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** Normalise a company name for comparison: lowercase, no punctuation, no leading "the", no trailing legal form. */
function normName(s) {
  const toks = decode(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (toks[0] === 'the') toks.shift();
  while (toks.length && LEGAL.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

function cc(reason, excerpt, source) {
  return { status: 'couldnt_check', reason, records: [], source_url: source || LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Read the register table. Returns { ok, rows, why }. Each row: { name, activities, expiry, detail_url }. */
function parseRegister(html) {
  const table = (html.match(/<table[\s\S]*?<\/table>/i) || [])[0] || '';
  if (!table || !/Expiry date of accreditation/i.test(table)) return { ok: false, why: 'register table not found' };
  if (!/<\/html>/i.test(html)) return { ok: false, why: 'page looks cut short (no closing html tag)' };
  const rows = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 3) continue; // header row uses <th>
    const a = cells[0].match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const name = cleanText(a ? a[2] : cells[0]);
    if (!name) continue;
    rows.push({
      name,
      activities: cleanText(cells[1]),
      expiry: cleanText(cells[2]),
      detail_url: a ? new URL(decode(a[1]), LIST_URL).href : '',
    });
  }
  if (rows.length === 0) return { ok: false, why: 'register table has no contractor rows' };
  return { ok: true, rows };
}

/** Value after a label on a detail page, up to the next label. */
function fieldAfter(txt, label) {
  const i = txt.indexOf(label);
  if (i < 0) return '';
  const rest = txt.slice(i + label.length);
  let end = rest.length;
  for (const b of BOUNDS) {
    if (b === label) continue;
    const j = rest.indexOf(b);
    if (j >= 0 && j < end) end = j;
  }
  return rest.slice(0, end).replace(/\/\/-->/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

async function enrich(m) {
  const rec = { name: m.name, matched_on: m.matched_on, activities: m.activities, expiry: m.expiry, detail_url: m.detail_url };
  if (!m.detail_url) { rec.detail = 'no detail link on the register list'; return rec; }
  try {
    const res = await fetch(m.detail_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) { rec.detail = `detail not loaded: HTTP ${res.status}`; return rec; }
    const txt = cleanText(await res.text());
    for (const [key, label] of Object.entries(LABELS)) {
      const v = fieldAfter(txt, label);
      if (v) rec[key] = v;
    }
  } catch (e) {
    rec.detail = 'detail not loaded: ' + String((e && e.name) || e).slice(0, 80);
  }
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = typeof keyword === 'string' ? keyword.trim() : '';
  try {
    if (!kw) return cc('other', 'empty company name');
    const want = normName(kw);
    if (!want) return cc('other', 'company name has no letters or digits');

    const res = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`);
    if (!res.ok) return cc('http_error', `HTTP ${res.status}`);
    if (/Authenticate\.aspx|\/login/i.test(res.url || '')) return cc('blocked', 'redirected to a login page: ' + res.url);

    const html = await res.text();
    const reg = parseRegister(html);
    if (!reg.ok) {
      if (/type=["']password["']/i.test(html) && !/acs-roac\.aspx\?contractor=/i.test(html)) return cc('blocked', 'login wall instead of the register');
      return cc('layout_changed', reg.why + ': ' + cleanText(html).slice(0, 200));
    }

    // Match the company, not similar words: normalised names must be equal. A register entry may hold
    // "legal name t/a trading name", so either part can match.
    const matches = [];
    for (const r of reg.rows) {
      const parts = r.name.split(/\s+t\/a\s+/i).map((p) => p.trim()).filter(Boolean);
      let matchedOn = '';
      if (normName(r.name) === want) matchedOn = 'full name';
      else if (parts[0] && normName(parts[0]) === want) matchedOn = 'legal name';
      else if (parts[1] && normName(parts[1]) === want) matchedOn = 'trading name';
      if (matchedOn) matches.push({ ...r, matched_on: matchedOn });
    }

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `"${kw}" is not among the ${reg.rows.length} entries of the complete register list` };
    }

    const records = await Promise.all(matches.map(enrich));
    const first = matches[0].detail_url || LIST_URL;
    return { status: 'found', reason: '', records, source_url: first,
      excerpt: `${records.length} match(es) for "${kw}" on the complete register list (${reg.rows.length} entries): ${records[0].name}` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timedOut ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
