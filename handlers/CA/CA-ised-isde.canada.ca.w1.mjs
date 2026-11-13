export const meta = {
  task: 'CA-ised-isde.canada.ca',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registry', 'registry_id', 'jurisdiction_id', 'business_number', 'entity_type', 'status', 'status_notes', 'date_incorporated', 'city', 'province'],
  canary: { found: 'SHOPIFY INC.', not_found: 'Entreprise Fantome Qzxvbnm Ltee' },
};

// The JSON search API that the site's own front end calls (config.js: SEARCH_API_URL). Plain GET, no key, no captcha.
const SEARCH_API = 'https://ised-isde.canada.ca/cbr/srch/api/v1/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words (English and French). Dropped before names are compared.
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'incorporee', 'ltd', 'limited', 'limitee', 'ltee', 'corp', 'corporation',
  'co', 'company', 'compagnie', 'cie', 'llc', 'llp', 'lp', 'ulc', 'ltc', 'srl', 'sa']);

/** Split a name into words (letters and digits in any script). */
function tokens(s) {
  return String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Lower case, no accents: the form used for comparing words. */
function key(w) {
  return w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Comparison key for a whole name: case, accents, punctuation and legal form removed. */
function nameKey(s) {
  return tokens(s).map(key).filter((t) => !LEGAL_FORMS.has(t)).join('');
}

/** The text sent to the search: the name as typed, without the legal form (the search is fuzzy, so the core name finds more). */
function searchText(s) {
  const all = tokens(s);
  const kept = all.filter((t) => !LEGAL_FORMS.has(key(t)));
  return (kept.length ? kept : all).join(' ');
}

function result(status, reason, records, sourceUrl, excerpt) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let sourceUrl = SEARCH_API;
  try {
    const want = nameKey(keyword) || tokens(keyword).map(key).join('');
    if (!want) return result('couldnt_check', 'other', [], sourceUrl, 'empty company name');

    const query = searchText(keyword);
    sourceUrl = `${SEARCH_API}?q=${encodeURIComponent(query)}`;

    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();

    if (res.status === 403 || res.status === 429) {
      return result('couldnt_check', 'blocked', [], sourceUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return result('couldnt_check', 'http_error', [], sourceUrl, `HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/captcha|challenge|turnstile|access denied/i.test(text)) {
        return result('couldnt_check', 'blocked', [], sourceUrl, text.slice(0, 300));
      }
      return result('couldnt_check', 'layout_changed', [], sourceUrl, text.slice(0, 300));
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.docs) || typeof data.totalResults !== 'number') {
      return result('couldnt_check', 'layout_changed', [], sourceUrl, JSON.stringify(data).slice(0, 300));
    }
    if (data.totalResults > data.docs.length) {
      return result('couldnt_check', 'other', [], sourceUrl,
        `search returned ${data.docs.length} of ${data.totalResults} results; the rest cannot be read`);
    }

    const matches = data.docs.filter((d) => nameKey(d.Company_Name) === want);
    if (matches.length === 0) {
      return result('not_found', '', [], sourceUrl,
        `${data.totalResults} result(s) for "${query}", none with the name "${keyword}"`);
    }

    const records = matches.map((d) => ({
      name: d.Company_Name || '',
      registry: d.Registry_Source || String(d.MRAS_ID || '').split('_')[0] || '',
      registry_id: d.MRAS_ID || '',
      jurisdiction_id: d.Juri_ID || '',
      business_number: d.BN || '',
      entity_type: d.Entity_Type || '',
      status: d.Status_State || '',
      status_notes: d.Status_Notes || '',
      date_incorporated: d.Date_Incorporated || '',
      city: d.Reg_office_city || '',
      province: d.Reg_office_province || '',
    }));

    const excerpt = records
      .map((r) => `${r.name} | ${r.registry} ${r.registry_id} | ${r.status}${r.status_notes ? ' (' + r.status_notes + ')' : ''}`)
      .join('; ');
    return result('found', '', records, sourceUrl, excerpt);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return result('couldnt_check', timedOut ? 'timeout' : 'other', [], sourceUrl, String(err?.message || err));
  }
}
