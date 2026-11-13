export const meta = { task: 'GB-sepa.org.uk', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'auth_id', 'authorisation_no', 'authorisation_status', 'authorisation_level', 'regulatory_area', 'description', 'status_date', 'representative_ngr', 'documents'],
  canary: { found: 'Diageo Scotland Limited', not_found: 'Blorvantic Widgets Ltd' } };

// The SEPA public register search page (search-the-register.sepa.org.uk/Find-Authorisations) loads its rows from this JSON API.
// The API matches the authorisation holder by "contains" (case-insensitive) and does not strip legal forms,
// so the handler searches the name without its legal form and then compares normalised holder names itself.
const API = 'https://webservices.sepa.org.uk/web.SEPA.PublicRegister.api.live/api/authorisations';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 500;
const MAX_PAGES = 10;          // 5,000 rows at most; a bigger result is reported as couldnt_check, never as not_found
const NEW_PAGE_DEADLINE = 30000; // no new page is started after 30 s, so the whole call ends well under 60 s

const LEGAL_WORDS = new Set(['limited', 'ltd', 'plc', 'llp', 'llc', 'co', 'company', 'cic', 'lp']);

/** Strip the legal form from the end of a name, keeping the rest as written (used as the search term). */
function withoutLegalForm(raw) {
  let words = String(raw || '').replace(/[.,;]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

/** Normalised key for comparing names: case, punctuation, "&"/"and", leading "The" and legal form ignored. */
function nameKey(raw) {
  let s = String(raw || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  let words = s.split(' ').filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words.shift();
  while (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function searchUrl(term, page) {
  const u = new URL(API);
  u.searchParams.set('pageSize', String(PAGE_SIZE));
  u.searchParams.set('pageNumber', String(page));
  u.searchParams.set('authorisationHolder', term);
  u.searchParams.set('orderColumn', 'authorisationHolder');
  u.searchParams.set('orderDir', 'asc');
  return u.href;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const term = withoutLegalForm(keyword);
  const wanted = nameKey(keyword);
  if (!term || !wanted) {
    return out('couldnt_check', 'other', [], API, 'the company name is empty after removing the legal form');
  }

  try {
    const seen = new Map(); // authID -> row, so a row that shows up on two pages is counted once
    let total = 0;
    let firstUrl = searchUrl(term, 1);

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > NEW_PAGE_DEADLINE) {
        return out('couldnt_check', 'timeout', [], firstUrl, `stopped after ${page - 1} pages (${seen.size} rows read of ${total})`);
      }
      const url = searchUrl(term, page);
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept': 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return out('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`);
      }

      const body = await res.text();
      let json;
      try { json = JSON.parse(body); } catch { json = null; }
      if (!json || typeof json !== 'object' || !Array.isArray(json.data) || typeof json.totalRecords !== 'number') {
        if (/captcha|cloudflare|access denied|are you a robot|verify you are human/i.test(body)) {
          return out('couldnt_check', 'blocked', [], url, body.slice(0, 300));
        }
        return out('couldnt_check', 'layout_changed', [], url, body.slice(0, 300));
      }

      total = json.totalRecords;
      for (const row of json.data) {
        if (!row || typeof row !== 'object') continue;
        const key = row.authID != null ? String(row.authID) : JSON.stringify(row);
        seen.set(key, row);
      }

      if (json.data.length === 0 || page * PAGE_SIZE >= total) break;
    }

    const matches = [...seen.values()].filter((r) => nameKey(r.authorisationHolder) === wanted);

    if (matches.length > 0) {
      const records = matches.map((r) => ({
        name: r.authorisationHolder || '',
        auth_id: r.authID ?? null,
        authorisation_no: r.authorisationNo || '',
        authorisation_status: r.authorisationStatus || '',
        authorisation_level: r.authorisationLevel || '',
        regulatory_area: r.regulatoryArea || '',
        description: r.authorisationDescription || '',
        status_date: r.statusDate || '',
        representative_ngr: r.representativeNGR || '',
        documents: r.documents === true,
      }));
      const names = [...new Set(records.map((r) => r.name))].join('; ');
      return out('found', '', records, firstUrl, `${records.length} authorisation(s) for holder: ${names}`);
    }

    if (total === 0 || seen.size >= total) {
      return out('not_found', '', [], firstUrl, `0 authorisation holders match "${term}" (${total} records returned for the search)`);
    }
    return out('couldnt_check', 'other', [], firstUrl,
      `no exact holder match among ${seen.size} of ${total} records; the result is too large to read every row`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timedOut ? 'timeout' : 'other', [], API, String(err?.message || err));
  }
}
