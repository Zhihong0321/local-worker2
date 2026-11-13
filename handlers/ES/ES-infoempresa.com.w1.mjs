export const meta = {
  task: 'ES-infoempresa.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_form', 'cif', 'id', 'status', 'city', 'community', 'constitution_date', 'cnae', 'industry', 'billing', 'last_accounts', 'uri'],
  canary: { found: 'TELEFONICA SA', not_found: 'Xqzvwkr Plmnbrt Oolfe SL' },
};

const SITE = 'https://www.infoempresa.com';
const SEARCH_API = `${SITE}/advanced_search_comp/get`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;      // the search API returns at most 100 results per page
const MAX_PAGES = 3;        // pages 0..2 only, so the whole call stays well under 60 s
const MAX_DETAIL = 3;       // CIF is read from the detail page of at most 3 matches

// Spanish legal forms, written as they appear after punctuation is removed ("S.A." -> "S A").
// Each pattern matches at the end of ' NAME ' (padded with spaces) and maps to one canonical code.
const LEGAL_FORMS = [
  [/ SOCIEDAD ANONIMA UNIPERSONAL $/, 'SAU'],
  [/ SOCIEDAD LIMITADA UNIPERSONAL $/, 'SLU'],
  [/ SOCIEDAD ANONIMA $/, 'SA'],
  [/ SOCIEDAD LIMITADA $/, 'SL'],
  [/ S A U $/, 'SAU'],
  [/ S L U $/, 'SLU'],
  [/ S A $/, 'SA'],
  [/ S L $/, 'SL'],
  [/ S L L $/, 'SLL'],
  [/ S L P $/, 'SLP'],
  [/ S R L $/, 'SRL'],
  [/ S C P $/, 'SCP'],
  [/ S A L $/, 'SAL'],
  [/ S COOP $/, 'SCOOP'],
  [/ SAU $/, 'SAU'],
  [/ SLU $/, 'SLU'],
  [/ SA $/, 'SA'],
  [/ SL $/, 'SL'],
  [/ SLL $/, 'SLL'],
  [/ SLP $/, 'SLP'],
  [/ SRL $/, 'SRL'],
  [/ SCP $/, 'SCP'],
  [/ SCOOP $/, 'SCOOP'],
  [/ AIE $/, 'AIE'],
  [/ COOP $/, 'COOP'],
];

/** Split a company name into its base name and canonical legal form ('' when none is given). */
function splitName(raw) {
  let s = ' ' + String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // accents
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')                          // punctuation and case
    .trim() + ' ';
  let form = '';
  for (const [re, code] of LEGAL_FORMS) {
    if (re.test(s)) { form = code; s = s.replace(re, ' '); break; }
  }
  return { base: s.trim().replace(/\s+/g, ' '), form };
}

/** The keyword matches a site name when the base names are equal and, if the keyword has a legal form, the forms are equal. */
function isSameCompany(keyword, siteName) {
  const k = splitName(keyword);
  const s = splitName(siteName);
  return k.base !== '' && k.base === s.base && (k.form === '' || k.form === s.form);
}

function statusOf(item) {
  if (Number(item.extincion) === 1) return 'extinguida';
  if (Number(item.activa) === 1) return 'activa';
  return 'inactiva';
}

function toRecord(item) {
  return {
    id: String(item.id ?? ''),
    name: item.company || '',
    legal_form: splitName(item.company).form,
    cif: '',
    status: statusOf(item),
    city: item.city || '',
    community: item.community || '',
    constitution_date: item.constitution_date || '',
    cnae: item.cnae || '',
    industry: item.industry || '',
    billing: item.billing || '',
    last_accounts: item.last_accounts || '',
    uri: item.uri ? new URL(item.uri, SITE).href : '',
  };
}

/** Read the CIF from a company detail page (header shows "CIF A28015865"). Returns '' when not shown. */
async function fetchCif(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return '';
    const html = await res.text();
    const m = html.match(/\bCIF\s+([A-Z0-9]{9})\b/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const q = String(keyword || '').trim();
  const sourceUrl = `${SITE}/es-es/es/buscar?q=${encodeURIComponent(q)}`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) });

  try {
    if (q.length < 2) return fail('other', 'company name too short for the site search (2 characters minimum)');
    if (!splitName(q).base) return fail('other', 'no searchable letters or digits in the company name');

    const matches = [];
    let scanned = 0;
    let timedOut = false;   // stopped early to keep the call under 60 s
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(SEARCH_API, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ websiteid: 'ESP_0000', page, lang: 'es', razon: q }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `search HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `search HTTP ${res.status}`);

      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!body) {
        if (/captcha|challenge-platform|cf-chl|are you a robot/i.test(text)) return fail('blocked', 'bot check page instead of search results');
        return fail('layout_changed', text.slice(0, 300));
      }
      if (body.success !== 1 && body.success !== true) {
        if (page === 0) return fail('other', 'search API answered success=0 on the first page');
        break; // no further pages
      }
      if (!Array.isArray(body.data)) return fail('layout_changed', 'search API data is not a list');

      scanned += body.data.length;
      for (const item of body.data) {
        if (isSameCompany(q, item.company) && !matches.some((m) => String(m.id) === String(item.id))) matches.push(item);
      }
      if (matches.length > 0 || body.data.length < PAGE_SIZE) break;
      if (elapsed() > 15000) { timedOut = true; break; }
    }

    if (matches.length === 0) {
      if (timedOut) return fail('timeout', `search ran out of time after ${scanned} results`);
      const note = scanned >= PAGE_SIZE * MAX_PAGES ? ` (first ${scanned} results checked)` : '';
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `No company named "${q}" among ${scanned} search results${note}`,
      };
    }

    const records = [];
    let firstDetail = '';
    for (const item of matches.slice(0, MAX_DETAIL)) {
      const rec = toRecord(item);
      if (elapsed() < 25000 && rec.uri) {
        rec.cif = await fetchCif(rec.uri, 25000);
        if (!firstDetail) firstDetail = rec.uri;
      }
      records.push(rec);
    }
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstDetail || sourceUrl,
      excerpt: `${first.name}${first.cif ? ', CIF ' + first.cif : ''}, ${first.status}, ${first.city}` +
        (matches.length > 1 ? ` (${matches.length} matches)` : ''),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, String(err?.message || err));
  }
}
