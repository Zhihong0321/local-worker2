export const meta = {
  task: 'CA-fct-cf.gc.ca',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['court_file_number', 'court', 'style_of_cause', 'parties', 'matched_party', 'filing_date', 'city', 'nature', 'proceeding_class', 'language'],
  canary: { found: 'MERCK SHARP & DOHME CANADA LTD', not_found: 'Société Introuvable Zqxw Ltée' },
};

// The Court Files search page (/en/court-files-and-decisions/court-files) calls this JSON endpoint in the browser
// (Content/js/base/data.js, ProceedingsQueriesPartyName). division=b is the site's "Both" option (Federal Court + Federal Court of Appeal).
const SEARCH = 'https://www.fct-cf.ca/CourtFilesAndDecisions/ProceedingsQueriesPartyInfo';
const REFERER = 'https://www.fct-cf.ca/en/court-files-and-decisions/court-files';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped from the END of a name before comparing (LTD = LIMITED = LTEE, INC = INCORPORATED ...).
const LEGAL_FORMS = new Set(['ltd', 'limited', 'ltee', 'inc', 'incorporated', 'corp', 'corporation', 'company', 'cie',
  'llc', 'lp', 'llp', 'srl', 'sas', 'gmbh', 'bv', 'plc', 'sdn', 'bhd', 'pte', 'pvt', 'ltda']);

/** Lower-case, no accents, only letters and digits (any script), legal form dropped from the end. */
function normalize(str) {
  const words = String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The text sent to the site: dots removed (the site finds "Ltd" but not "Ltd."), legal form removed (the site
 *  searches by "contains", so the shorter core name finds every spelling of the company). */
function searchTerm(keyword) {
  const words = String(keyword || '').replace(/\./g, '').split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(normalize(words[words.length - 1]))) words.pop();
  let term = words.join(' ');
  if (term.length < 3) term = String(keyword || '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
  // Only the characters the site's own search box accepts.
  return term.replace(/[^A-Za-z0-9À-ÿ\-,&()'’ ]/g, '').replace(/\s+/g, ' ').trim();
}

function fmtDate(v) {
  const m = /\/Date\((-?\d+)\)\//.exec(String(v || ''));
  if (!m) return String(v || '');
  const d = new Date(Number(m[1]));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

/** Party names of one case: the Party list, plus the two sides of STYLE_OF_CAUSE ("A v. B ET AL"). */
function partyNames(rec) {
  const names = Array.isArray(rec.Party) ? rec.Party.filter(Boolean) : [];
  const sides = String(rec.STYLE_OF_CAUSE || '').split(/\s+v\.?s?\.?\s+/i).map((s) => s.replace(/\s+ET AL\.?$/i, ''));
  return [...names, ...sides];
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = SEARCH;
  try {
    const term = searchTerm(keyword);
    const kwCore = normalize(keyword);
    if (!term || !kwCore) {
      return couldnt('other', SEARCH, 'the name has no characters the site search accepts');
    }
    url = `${SEARCH}?division=b&name=${encodeURIComponent(term)}&from=&to=`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': REFERER,
      },
    });

    if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|access denied|robot/i.test(text.slice(0, 2000))) return couldnt('blocked', url, text.slice(0, 300));

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return couldnt('layout_changed', url, text.slice(0, 300));
    }
    if (!json || !Array.isArray(json.data)) return couldnt('layout_changed', url, text.slice(0, 300));

    const records = [];
    for (const rec of json.data) {
      const hit = partyNames(rec).find((n) => kwCore && normalize(n) === kwCore);
      if (!hit) continue;
      records.push({
        court_file_number: rec.COURT_NO ?? '',
        court: rec.ENGLISH_PROCEEDING_TYPE ?? '',
        style_of_cause: rec.STYLE_OF_CAUSE ?? '',
        parties: Array.isArray(rec.Party) ? rec.Party.filter(Boolean) : [],
        matched_party: hit,
        filing_date: fmtDate(rec.FILE_DT),
        city: rec.ENGLISH_CITY_NAME ?? '',
        nature: rec.ENGLISH_NATURE_DESC ?? '',
        proceeding_class: rec.ENGLISH_PROCEEDING_CLASS ?? '',
        language: rec.ENGLISH_LANGUAGE_NAME ?? '',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `Search "${term}" returned ${json.data.length} case(s); none has a party named "${keyword}"`,
      };
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: `${first.court_file_number} ${first.style_of_cause} (${first.court}, filed ${first.filing_date})`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', url, String(err?.message || err));
  }
}
