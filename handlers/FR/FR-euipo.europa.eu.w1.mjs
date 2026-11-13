export const meta = { task: 'FR-euipo.europa.eu', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'number', 'legal_entity', 'legal_form', 'status', 'street', 'postcode', 'city', 'country'],
  canary: { found: 'MICHELIN EDITIONS', not_found: 'Société Fictive Zyqwxv SAS' } };

// EUIPO eSearch plus, "Owners" tab: POST form to the JSON search endpoint the site's own page uses.
// Public search, no login, no token. Legal-form words are removed before searching, because the
// index does not match "MICHELIN EDITIONS SAS" (it returns 0), and before comparing names.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://euipo.europa.eu/copla/applicantsearch/json';
const DETAIL_URL = 'https://euipo.europa.eu/copla/applicant/data/';
const ROWS = 100;          // rows per page
const MAX_ROWS = 500;      // at most 5 pages per lookup
const BUDGET_MS = 45000;   // stop starting new requests after this, so the whole call stays under 60 s
const MAX_RECORDS = 5;
const LEGAL_FORMS = new Set(['SAS', 'SASU', 'SARL', 'EURL', 'SA', 'SCI', 'SNC', 'SCA', 'SCOP', 'EI', 'EIRL', 'SELARL',
  'SELAS', 'SE', 'GMBH', 'AG', 'KG', 'LTD', 'LIMITED', 'LLC', 'INC', 'CORP', 'CO', 'BV', 'NV', 'SRL', 'SPA', 'PLC',
  'SL', 'SLU', 'AB', 'OY']);

/** Upper-case ASCII letters and digits, accents and apostrophes removed, everything else a space. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Normalised name with trailing legal-form words removed: the key two names must share. */
function coreKey(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** The search term as the user typed it, minus trailing legal-form words. */
function searchTerm(keyword) {
  const w = String(keyword).replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  while (w.length > 1 && LEGAL_FORMS.has(fold(w[w.length - 1]).replace(/ /g, ''))) w.pop();
  return w.join(' ');
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: SEARCH_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  try {
    const kw = String(keyword || '').trim();
    const key = coreKey(kw);
    if (!key) return fail('other', 'empty company name');
    const term = searchTerm(kw);

    const matches = [];
    let scanned = 0;
    let total = 0;
    for (let start = 0; start < MAX_ROWS; start += ROWS) {
      if (Date.now() - t0 > BUDGET_MS) return fail('timeout', `EUIPO search did not finish within ${BUDGET_MS / 1000} s`);

      const body = new URLSearchParams({ start: String(start), rows: String(ROWS), searchMode: 'basic',
        criterion_1: 'ApplicantName', term_1: term, operator_1: 'OR' });
      const res = await fetch(SEARCH_URL, {
        method: 'POST', body,
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || typeof data.total !== 'number' || !Array.isArray(data.items)) {
        if (/captcha|challenge|sign in|log in|login/i.test(text.slice(0, 3000))) return fail('blocked', text.slice(0, 200));
        return fail('layout_changed', text.slice(0, 200));
      }

      total = data.total;
      for (const it of data.items) {
        scanned++;
        if (coreKey(it.name || it.orga) === key) matches.push(it);
      }
      if (data.items.length < ROWS || scanned >= total) break;
    }

    if (matches.length === 0) {
      if (scanned < total) {
        return fail('other', `EUIPO returned ${total} results for "${term}"; only the first ${scanned} were checked`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `EUIPO owner search for "${term}": 0 matching records` };
    }

    // Matched owners: add the address and legal form from the owner's public detail record.
    const records = [];
    for (const m of matches.slice(0, MAX_RECORDS)) {
      const rec = { name: m.name || m.orga || '', number: String(m.id), legal_entity: m.legalentity || '',
        legal_form: '', status: '', street: m.street || '', postcode: m.postcode || '', city: m.city || '',
        country: String(m.country || '').replace(/country$/i, '') };
      if (Date.now() - t0 < BUDGET_MS) {
        try {
          const d = await fetch(DETAIL_URL + encodeURIComponent(m.id), {
            headers: { 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            signal: AbortSignal.timeout(25000),
          });
          if (d.ok) {
            const j = await d.json();
            const a = j.address || {};
            rec.name = j.name || rec.name;
            rec.legal_entity = j.legal || rec.legal_entity;
            rec.legal_form = Array.isArray(j.legalForm) ? j.legalForm.join('; ') : '';
            rec.status = j.status || '';
            rec.street = a.street || rec.street;
            rec.postcode = a.postcode || rec.postcode;
            rec.city = a.city || rec.city;
            rec.country = String(a.countryCode || rec.country).replace(/country$/i, '');
          }
        } catch { /* keep the search-level fields */ }
      }
      records.push(rec);
    }

    const names = records.map((r) => `${r.name} (${r.number})`).join('; ');
    const more = matches.length > records.length ? ` (first ${records.length} shown)` : '';
    return { status: 'found', reason: '', records, source_url: SEARCH_URL,
      excerpt: `EUIPO owner search for "${term}": ${matches.length} matching record(s)${more}: ${names}`.slice(0, 500) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
