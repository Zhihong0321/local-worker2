export const meta = { task: 'IE-rtb.ie', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'subject', 'court_order_no', 'sanction_date', 'tenancy_address', 'landlord_address', 'sanction_amount'],
  canary: { found: 'Eastat Limited', not_found: 'Cuideachta Neamhainmnithe Teoranta' } };

// Scope: the RTB "Search investigation court orders" list (enforcement court orders and sanctions, landlords incl. companies).
// The RTB search is a FacetWP list; the same endpoint serves the page's own search box.
const ENDPOINT = 'https://rtb.ie/wp-json/facetwp/v1/refresh';
const TEMPLATE = 'court_orders_listing';
const SOURCE_URL = 'https://rtb.ie/compliance/enforcement-outcomes/search-investigation-court-orders/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEADLINE_MS = 45000;
const MAX_PAGES = 40;
const LEGAL_FORMS = new Set(['ltd', 'limited', 'dac', 'clg', 'unlimited', 'teoranta', 'teo', 'sarl', 'plc', 'llc', 'inc', 'co',
  'company', 'designated', 'activity', 'cuideachta']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

/** Plain text of an HTML fragment; tag boundaries become ' | ' so field labels can be read. */
function plain(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' | '))
    .replace(/\s+/g, ' ').replace(/(\s*\|\s*)+/g, ' | ').trim();
}

/** Normalised company name: case, accents, punctuation and legal form removed. */
function normalizeName(s) {
  return decodeEntities(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join('');
}

function field(text, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(esc + '\\s*\\|\\s*([^|]+?)\\s*(?:\\||$)'));
  return m ? m[1].trim() : '';
}

/** One FacetWP refresh call: the same POST the page's own search box makes. */
async function refresh(keyword, paged) {
  const body = new URLSearchParams();
  body.append('action', 'facetwp_refresh');
  body.append('data[facets][search][]', keyword);
  body.append('data[template]', TEMPLATE);
  body.append('data[paged]', String(paged));
  body.append('data[extras][sort]', 'default');
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { err: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other', excerpt: String(e && e.message || e) };
  }
  if (res.status === 403 || res.status === 429) return { err: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { err: 'http_error', excerpt: `HTTP ${res.status}` };
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!json || typeof json.template !== 'string' || !json.settings || !json.settings.pager) {
    return { err: 'layout_changed', excerpt: text.slice(0, 300) };
  }
  return { json };
}

/** Split one page's listing into entries: each entry starts with its <h3> title. */
function parseEntries(template) {
  const parts = String(template || '').split(/<h3\b[^>]*>/i).slice(1);
  const entries = [];
  for (const part of parts) {
    const end = part.indexOf('</h3>');
    if (end < 0) return null;
    const titleText = plain(part.slice(0, end)).replace(/\s*\|\s*/g, ' ').trim();
    const bodyText = plain(part.slice(end + 5));
    const titleName = titleText.split(/\s+[–—-]\s+/)[0].trim();
    entries.push({
      titleName,
      landlord: field(bodyText, 'Landlord'),
      subject: titleText.split(/\s+[–—-]\s+/).slice(1).join(' - '),
      court_order_no: field(bodyText, 'Court Order No.'),
      sanction_date: field(bodyText, 'Sanction Date'),
      tenancy_address: field(bodyText, 'Tenancy Address'),
      landlord_address: field(bodyText, 'Landlord Address'),
      sanction_amount: field(bodyText, 'Amount of Monetary Sanction'),
      text: bodyText,
    });
  }
  return entries;
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: SOURCE_URL, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const kwNorm = normalizeName(kw);
    if (!kwNorm) return fail('other', 'empty company name');

    const first = await refresh(kw, 1);
    if (first.err) return fail(first.err, first.excerpt);
    const pager = first.json.settings.pager;
    const totalRows = Number(pager.total_rows) || 0;
    const totalPages = Number(pager.total_pages) || 0;

    if (totalRows === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: SOURCE_URL,
        excerpt: `Searched the court orders list for "${kw}": 0 results.` };
    }
    if (totalPages > MAX_PAGES) return fail('other', `${totalRows} search hits; too many to check every page within 60 s`);

    const pages = [first.json];
    for (let p = 2; p <= totalPages; p += 5) {
      if (Date.now() - started > DEADLINE_MS) return fail('timeout', 'not every result page was read within 45 s');
      const batch = [];
      for (let q = p; q < p + 5 && q <= totalPages; q++) batch.push(refresh(kw, q));
      const results = await Promise.all(batch);
      for (const r of results) {
        if (r.err) return fail(r.err, r.excerpt);
        pages.push(r.json);
      }
    }

    const all = [];
    for (const page of pages) {
      const entries = parseEntries(page.template);
      if (entries === null) return fail('layout_changed', page.template.slice(0, 300));
      all.push(...entries);
    }
    if (all.length !== totalRows) {
      return fail('layout_changed', `read ${all.length} entries, the search says ${totalRows}`);
    }

    const matches = all.filter((e) => normalizeName(e.titleName) === kwNorm || normalizeName(e.landlord) === kwNorm);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: SOURCE_URL,
        excerpt: `Searched the court orders list for "${kw}": ${totalRows} hits, none is this company. ` +
          'The adjudication / tribunal determination orders list is not checked by this handler.' };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({
        name: e.landlord || e.titleName,
        subject: e.subject,
        court_order_no: e.court_order_no,
        sanction_date: e.sanction_date,
        tenancy_address: e.tenancy_address,
        landlord_address: e.landlord_address,
        sanction_amount: e.sanction_amount,
      })),
      source_url: SOURCE_URL,
      excerpt: matches[0].text.slice(0, 500),
    };
  } catch (err) {
    return fail('other', err && err.message || err);
  }
}
