export const meta = {
  task: 'FR-georisques.gouv.fr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'siret', 'codeAIOT', 'address', 'postal_code', 'commune', 'code_insee', 'naf_code', 'regime',
    'activity_status', 'seveso_status', 'ied', 'national_priority', 'inspection_service', 'last_inspection',
    'date_updated', 'detail_url'],
  canary: { found: 'ARCELORMITTAL FRANCE', not_found: 'Entreprise Introuvable Fictive SAS' },
};

const API = 'https://www.georisques.gouv.fr/api/v1/installations_classees';
const DETAIL = 'https://www.georisques.gouv.fr/risques/installations/donnees/details/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 1000;   // the API returns up to this many installations per page
const MAX_PAGES = 5;      // more than 5000 matches of a name fragment: not every page is checked, so say so
const DEADLINE_MS = 50000; // stay well under the 60 s limit

// French legal forms, removed from the end of a name before comparing.
const LEGAL = new Set(['sas', 'sasu', 'sarl', 'sarlu', 'eurl', 'sa', 'sci', 'snc', 'sca', 'scop', 'scs', 'se', 'gie',
  'selarl', 'selas', 'sem']);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalised company key: case, accents, punctuation, spaces and trailing legal form removed. */
function companyKey(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join('');
}

/** The search text as typed (legal form removed), and the same text without accents (the API is accent-sensitive). */
function queryVariants(keyword) {
  const parts = String(keyword || '').trim().split(/\s+/).filter(Boolean);
  while (parts.length && fold(parts[parts.length - 1]).split(' ').filter(Boolean).every((w) => LEGAL.has(w))) parts.pop();
  const typed = parts.join(' ');
  const plain = typed.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return { typed, variants: plain !== typed ? [typed, plain] : [typed] };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || '', excerpt: String(excerpt || '').slice(0, 500) };
}

function isTimeout(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

function toRecord(r) {
  const dates = (r.inspections || []).map((i) => i.dateInspection).filter(Boolean).sort();
  return {
    name: r.raisonSociale || '',
    siret: r.siret || '',
    codeAIOT: r.codeAIOT || '',
    address: [r.adresse1, r.adresse2, r.adresse3].filter(Boolean).join(', '),
    postal_code: r.codePostal || '',
    commune: r.commune || '',
    code_insee: r.codeInsee || '',
    naf_code: r.codeNaf || '',
    regime: r.regime || '',
    activity_status: r.etatActivite || '',
    seveso_status: r.statutSeveso || '',
    ied: r.ied ?? null,
    national_priority: r.prioriteNationale ?? null,
    inspection_service: r.serviceAIOT || '',
    last_inspection: dates.length ? dates[dates.length - 1] : null,
    date_updated: r.date_maj || '',
    detail_url: r.codeAIOT ? DETAIL + r.codeAIOT : '',
  };
}

/** Runs one search text through every result page. Returns exact-name matches, or a failure. */
async function runQuery(query, key, deadline) {
  const matches = [];
  let firstUrl = '';
  let totalPages = 1;
  let totalResults = 0;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
    const url = `${API}?raisonSociale=${encodeURIComponent(query)}&page=${page}&page_size=${PAGE_SIZE}`;
    if (!firstUrl) firstUrl = url;
    if (Date.now() > deadline) return { ok: false, reason: 'timeout', source_url: firstUrl, excerpt: 'the lookup ran out of time' };

    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    } catch (e) {
      return { ok: false, reason: isTimeout(e) ? 'timeout' : 'other', source_url: url, excerpt: String(e?.message || e) };
    }
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', source_url: url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'http_error', source_url: url, excerpt: `HTTP ${res.status}` };

    let text;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, reason: isTimeout(e) ? 'timeout' : 'other', source_url: url, excerpt: String(e?.message || e) };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      const bot = /captcha|access denied|cloudflare|just a moment/i.test(text);
      return { ok: false, reason: bot ? 'blocked' : 'layout_changed', source_url: url, excerpt: text.slice(0, 300) };
    }
    if (!j || !Array.isArray(j.data)) return { ok: false, reason: 'layout_changed', source_url: url, excerpt: text.slice(0, 300) };

    if (page === 1) {
      totalResults = Number(j.results) || 0;
      totalPages = Math.max(1, Number(j.total_pages) || 1);
    }
    for (const row of j.data) {
      const k = companyKey(row.raisonSociale);
      if (key && k === key) matches.push(row);
    }
  }
  return { ok: true, matches, source_url: firstUrl, truncated: totalPages > MAX_PAGES, totalResults };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const { typed, variants } = queryVariants(keyword);
    const key = companyKey(keyword);
    if (!typed || !key) return couldnt('other', '', 'the name has no words left to search once the legal form is removed');

    const found = new Map();
    let matchUrl = '';
    let firstUrl = '';
    let failure = null;
    let truncated = false;

    for (const q of variants) {
      const r = await runQuery(q, key, deadline);
      if (!firstUrl) firstUrl = r.source_url;
      if (!r.ok) {
        failure = failure || r;
        continue;
      }
      truncated = truncated || r.truncated;
      for (const row of r.matches) {
        const id = `${row.codeAIOT}|${row.siret}|${row.raisonSociale}|${row.adresse1}`;
        if (!found.has(id)) found.set(id, row);
        if (!matchUrl) matchUrl = r.source_url;
      }
    }

    if (found.size) {
      const records = [...found.values()].map(toRecord);
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchUrl,
        excerpt: `${records.length} installation(s) under "${first.name}": ${first.commune} (${first.postal_code}), ` +
          `AIOT ${first.codeAIOT}, ${first.regime}, ${first.seveso_status}`,
      };
    }
    if (failure) return couldnt(failure.reason, failure.source_url, failure.excerpt);
    if (truncated) return couldnt('other', firstUrl, 'too many installations contain this text to check every page');
    return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: `0 installations named "${typed}"` };
  } catch (err) {
    return couldnt('other', `${API}?raisonSociale=${encodeURIComponent(String(keyword || ''))}`, String(err?.message || err));
  }
}
