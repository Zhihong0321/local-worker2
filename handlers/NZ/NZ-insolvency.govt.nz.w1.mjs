export const meta = {
  task: 'NZ-insolvency.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'estate_number', 'nzbn', 'estate_type', 'status', 'adjudication_date', 'adjudication_address', 'office', 'current_name', 'alternate_names', 'matched_on', 'matched_name'],
  canary: { found: 'BLANERNE LIMITED', not_found: 'Ngā Tūpuna Mahi Limited' },
};

// The Insolvency Register search page (app.insolvency.govt.nz) calls this public JSON search with no login.
// The server refuses requests without an Origin or Referer header, so the register page is sent as Referer.
const SITE = 'https://app.insolvency.govt.nz';
const REGISTER_PAGE = `${SITE}/ui/public/search/insolvency-register`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 50;
const MAX_PAGES = 4;            // 200 results at most per search text
const NO_NEW_FETCH_AFTER_MS = 30000; // a fetch takes at most 25 s, so the whole call stays under 60 s
const LEGAL_FORMS = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company']);

/** Lower case, accents and macrons removed, '&' read as 'and', punctuation removed. */
function fold(s) {
  return String(s || '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Normalised name with trailing legal-form words removed, so 'ACME LTD' and 'Acme Limited' compare equal. */
function core(s) {
  const words = fold(s).split(' ').filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The search text with a trailing legal form removed (used as a second, wider search). */
function stripLegalForm(s) {
  const words = s.split(' ');
  while (words.length > 1 && LEGAL_FORMS.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

/** Name forms one register name can be read as: the whole name, without brackets, the start up to each legal form
 *  (e.g. 'TREEHOUSE (NZ) LTD' inside 'TREEHOUSE (NZ) LTD (HOUSE & GARDEN LTD)'), and the parts around 'FM:', 'NOW', 'PREV'. */
function variants(raw) {
  const t = String(raw || '').replace(/[,\s]+$/, '').trim();
  if (!t) return [];
  const out = [t];
  const toks = t.split(/\s+/);
  toks.forEach((w, i) => { if (LEGAL_FORMS.has(fold(w))) out.push(toks.slice(0, i + 1).join(' ')); });
  for (const piece of t.split(/\s+FM:?\s+|\s+NOW\s+|\(\s*PREV\.?|\(\s*FM:?/i)) {
    const p = piece.replace(/[)\s,]+$/, '').trim();
    if (p) out.push(p);
  }
  return out;
}

/** Returns which register name (current, former or the estate name) equals the typed company, or null. */
function matchRecord(r, target) {
  const sources = [
    ['estate name', r.estateName],
    ['current name', r.currentName],
    ['organisation name', r.estateOrganisationName],
    ...((Array.isArray(r.alternateNames) ? r.alternateNames : []).map((n) => ['former name', n])),
  ];
  for (const [label, value] of sources) {
    for (const v of variants(value)) {
      if (core(v) && core(v) === target) return { label, name: String(value).replace(/[,\s]+$/, '').trim() };
    }
  }
  return null;
}

function cc(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Reads every results page for one search text (up to MAX_PAGES). Never throws. */
async function searchAll(term, startedAt) {
  const results = [];
  let totalItems = 0;
  let totalPages = 0;
  let url = '';
  let page = 1;
  do {
    if (Date.now() - startedAt > NO_NEW_FETCH_AFTER_MS) {
      return { fail: cc('timeout', url, 'stopped before the 60 s limit; the search was not finished') };
    }
    url = `${SITE}/api/public/estates/search?searchTerms=${encodeURIComponent(term)}&page=${page}&page-size=${PAGE_SIZE}`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Origin': SITE,
          'Referer': REGISTER_PAGE,
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { fail: cc(t ? 'timeout' : 'other', url, 'request failed: ' + String(e).slice(0, 200)) };
    }

    let body;
    try {
      body = await res.text();
    } catch (e) {
      const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { fail: cc(t ? 'timeout' : 'other', url, 'reading the response failed: ' + String(e).slice(0, 200)) };
    }

    if (!res.ok) {
      if (res.status === 403 || res.status === 429 || res.status === 401) {
        return { fail: cc('blocked', url, `HTTP ${res.status}`) };
      }
      return { fail: cc('http_error', url, `HTTP ${res.status}: ${body.slice(0, 200)}`) };
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      if (/captcha|cf-chl|challenge|log ?in/i.test(body.slice(0, 3000))) {
        return { fail: cc('blocked', url, 'the site returned a challenge or login page') };
      }
      return { fail: cc('layout_changed', url, body.slice(0, 300)) };
    }

    if (!data || !Array.isArray(data.searchResults)) {
      const msg = data && data.errorMessage ? `${data.errorMessage}: ${data.errorDescription || ''}` : JSON.stringify(data).slice(0, 300);
      return { fail: cc(data && data.errorMessage ? 'http_error' : 'layout_changed', url, msg) };
    }

    totalItems = Number(data.totalItems) || 0;
    totalPages = Number(data.totalPages) || 0;
    results.push(...data.searchResults);
    page += 1;
  } while (page <= totalPages && page <= MAX_PAGES);

  return { ok: true, results, totalItems, truncated: totalPages > MAX_PAGES, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const typed = String(keyword || '').replace(/\s+/g, ' ').trim();
    if (!typed) return cc('other', '', 'empty company name');

    const target = core(typed);
    if (!target) return cc('other', '', 'no usable name left after removing the legal form');

    const started = Date.now();
    const terms = [...new Set([typed, stripLegalForm(typed)].filter(Boolean))];

    let truncatedUrl = null;
    let lastUrl = '';
    let lastTotal = 0;

    for (const term of terms) {
      const s = await searchAll(term, started);
      if (s.fail) return { status: 'couldnt_check', ...s.fail };
      lastUrl = s.url;
      lastTotal = s.totalItems;

      const seen = new Set();
      const records = [];
      for (const r of s.results) {
        const m = matchRecord(r, target);
        if (!m || seen.has(r.estateNumber)) continue;
        seen.add(r.estateNumber);
        records.push({
          name: String(r.estateName || '').replace(/[,\s]+$/, '').trim(),
          estate_number: r.estateNumber || '',
          nzbn: r.nzbn || '',
          estate_type: r.estateTypeDisplay || r.estateType || '',
          status: r.insolvencyStatus || '',
          adjudication_date: r.estateAdjudicationDate || '',
          adjudication_address: r.adjudicationAddress || '',
          office: r.officeOfficerDisplay || '',
          current_name: r.currentName || '',
          alternate_names: Array.isArray(r.alternateNames) ? r.alternateNames : [],
          matched_on: m.label,
          matched_name: m.name,
        });
      }

      if (records.length) {
        return {
          status: 'found',
          reason: '',
          records,
          source_url: s.url,
          excerpt: `${records.length} matching record(s) for "${typed}" among ${s.totalItems} search results`,
        };
      }
      if (s.truncated) truncatedUrl = s.url;
    }

    if (truncatedUrl) {
      return cc('other', truncatedUrl, `"${typed}" gives more than ${MAX_PAGES * PAGE_SIZE} search results; the match could not be checked in full`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `no record matches "${typed}"; the search returned ${lastTotal} result(s), none with this company name`,
    };
  } catch (e) {
    return cc('other', '', 'the handler threw: ' + String(e).slice(0, 200));
  }
}
