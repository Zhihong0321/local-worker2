export const meta = {
  task: 'IE-epa.ie',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_id', 'authorisation_number', 'authorisation_name', 'authorisation_type', 'organisation', 'status', 'county', 'sector', 'issued_date'],
  canary: { found: 'Aughinish Alumina Limited', not_found: 'Cuideachta Neamhliostaithe Teoranta' },
};

// EPA LEAP Online (leap.epa.ie) is a React app; its licence search reads this public JSON API.
const API = 'https://data.epa.ie/leap/api/v1/Licence/licencesearchlistfilters';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 100;
const MAX_PAGES = 10;
const DEADLINE_MS = 40000;
// Legal-form words that are stripped from the END of a name before comparing (Irish and common forms).
const LEGAL_FORMS = new Set(['limited', 'ltd', 'unlimited', 'unltd', 'teoranta', 'teo', 'dac', 'plc', 'company', 'co', 'cuideachta', 'llc', 'inc', 'gmbh']);

/** Lower-case, strip accents (fadas), punctuation to spaces; keeps letters of any script. */
function fold(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalised name without its trailing legal form, e.g. "Intel Ireland Ltd" -> "intel ireland". */
function coreName(str) {
  const tokens = fold(str).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** The keyword as typed, minus trailing legal-form words (the site search is sent this text). */
function searchText(input) {
  const words = input.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  if (!input) return couldnt('other', API, 'empty company name');

  const term = searchText(input);
  const wanted = coreName(input);
  const firstUrl = `${API}?page=1&per_page=${PER_PAGE}&search_term=${encodeURIComponent(term)}`;

  try {
    const rows = [];
    let total = null;
    for (let page = 1; ; page++) {
      const url = `${API}?page=${page}&per_page=${PER_PAGE}&search_term=${encodeURIComponent(term)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', firstUrl, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', firstUrl, `HTTP ${res.status}`);

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return couldnt('layout_changed', firstUrl, text.slice(0, 300));
      }
      if (!data || !Array.isArray(data.list) || typeof data.count !== 'number') {
        return couldnt('layout_changed', firstUrl, text.slice(0, 300));
      }

      total = data.count;
      rows.push(...data.list);
      if (data.list.length === 0 || rows.length >= total) break;
      if (page >= MAX_PAGES || Date.now() - started > DEADLINE_MS) break;
    }

    // Match the licensee (organisation) by normalised name, legal form removed on both sides.
    const matches = rows.filter((r) => coreName(r.organisation) === wanted);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.organisation,
          licence_id: r.licenceid,
          authorisation_number: r.authorisationnumber,
          authorisation_name: r.authorisationname,
          authorisation_type: r.authorisationtype,
          organisation: r.organisation,
          status: r.status,
          county: r.county,
          sector: r.sector,
          issued_date: r.finalauthorisationissueddate,
        })),
        source_url: firstUrl,
        excerpt: `${matches.length} licence record(s) for "${matches[0].organisation}" (search "${term}", ${total} result(s) in total)`,
      };
    }

    // Not on the site only if every matching row was read.
    if (rows.length < total) {
      return couldnt('other', firstUrl, `search "${term}" has ${total} rows; only ${rows.length} read before stopping`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `search "${term}" returned ${total} row(s); none has organisation "${input}"`,
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return couldnt(reason, firstUrl, String(err?.message || err).slice(0, 300));
  }
}
