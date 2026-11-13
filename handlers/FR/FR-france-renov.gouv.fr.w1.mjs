// France Rénov' annuaire RGE: company-name lookup.
// The annuaire page (https://france-renov.gouv.fr/annuaires-professionnels/artisan-rge-architecte) has no server-side
// results. Its bundled form script (/web-component/forms/1.24.3/forms.js) runs the RGE company search in the browser
// against the public ADEME open-data dataset "historique-rge" (data.ademe.fr). This handler makes the same kind of
// JSON request: first an exact name filter (qs), then a full-text search (q), then keeps only rows whose normalised
// company name equals the keyword's normalised name (case, accents, punctuation and legal form ignored).

export const meta = {
  task: 'FR-france-renov.gouv.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'siret', 'address', 'postal_code', 'commune', 'qualification', 'certificate', 'organisme',
    'domain', 'date_start', 'date_end', 'processing_finished'],
  canary: { found: 'Bouygues Batiment IDF', not_found: 'Entreprise Fantôme Zzqxvb' },
};

const BASE = 'https://data.ademe.fr/data-fair/api/v1/datasets/historique-rge/lines';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['sarl', 'sas', 'sasu', 'eurl', 'sa', 'sci', 'snc', 'sca', 'scop', 'earl', 'ei']);

/** Core name: lower case, no accents, no punctuation, no legal form words, no spaces. */
function normalise(str) {
  return String(str || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

/** The keyword with legal-form words removed, spacing and case kept (used for the search requests). */
function coreName(keyword) {
  return String(keyword || '')
    .split(/\s+/)
    .filter((t) => t && !LEGAL_FORMS.has(t.replace(/[^A-Za-z]/g, '').toLowerCase()))
    .join(' ')
    .replace(/["\\]/g, '')
    .trim();
}

function failure(status, reason, sourceUrl, excerpt) {
  return { status, reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: failure('couldnt_check', 'blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: failure('couldnt_check', 'http_error', url, `HTTP ${res.status}`) };
  let body;
  try {
    body = await res.json();
  } catch {
    return { fail: failure('couldnt_check', 'layout_changed', url, 'response is not JSON') };
  }
  if (!body || !Array.isArray(body.results)) {
    return { fail: failure('couldnt_check', 'layout_changed', url, 'no results array in response') };
  }
  return { body };
}

function toRecord(r) {
  return {
    name: r.nom_entreprise || '',
    siret: r.siret || '',
    address: r.adresse || '',
    postal_code: r.code_postal || '',
    commune: r.commune || '',
    qualification: r.nom_qualification || '',
    certificate: r.nom_certificat || '',
    organisme: r.organisme || '',
    domain: r.domaine || '',
    date_start: r.date_debut || '',
    date_end: r.date_fin || '',
    processing_finished: r.traitement_termine === true,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchSource = `${BASE}?q=${encodeURIComponent(String(keyword || ''))}`;
  try {
    const core = coreName(keyword);
    const target = normalise(keyword);
    if (!core || !target) {
      return failure('couldnt_check', 'other', searchSource, 'empty company name');
    }

    // 1) exact stored name (case-sensitive exact match in the dataset)
    const exactUrl = `${BASE}?qs=${encodeURIComponent(`nom_entreprise:"${core}"`)}&size=200`;
    // 2) full-text search, the same kind of request the annuaire page sends
    const fullUrl = `${BASE}?q=${encodeURIComponent(core)}&q_mode=simple&size=200`;

    const exact = await getJson(exactUrl);
    if (exact.fail) return { ...exact.fail, source_url: exactUrl };
    const full = await getJson(fullUrl);
    if (full.fail) return { ...full.fail, source_url: fullUrl };

    const seen = new Set();
    const matches = [];
    for (const r of [...exact.body.results, ...full.body.results]) {
      if (normalise(r.nom_entreprise) !== target) continue;
      const key = JSON.stringify([r.siret, r.nom_qualification, r.date_debut, r.date_fin, r.traitement_termine]);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(r);
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: fullUrl,
        excerpt: `0 rows with company name "${core}" (full-text search returned ${full.body.results.length} rows, total ${full.body.total ?? '?'})`,
      };
    }

    const records = matches.map(toRecord);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: fullUrl,
      excerpt: `${records.length} RGE rows for ${records[0].name} (SIRET ${records[0].siret}, ${records[0].postal_code} ${records[0].commune})`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure('couldnt_check', timedOut ? 'timeout' : 'other', searchSource, String(err?.message || err));
  }
}
