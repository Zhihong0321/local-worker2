export const meta = { task: 'FR-transparence.sante.gouv.fr', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'site_id'],
  canary: { found: 'MERCK MÉDICATION FAMILIALE', not_found: 'SOCIÉTÉ FANTÔME ZZQX SARL' } };

// The site's "Entreprises" page is an OpenDataSoft explore widget over the dataset entreprise-prod-unique
// (company names that declared financial links to health professionals). The same JSON API is public.
const DATASET_URL = 'https://www.transparence.sante.gouv.fr/api/explore/v2.1/catalog/datasets/entreprise-prod-unique/records';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;            // rows per request
const MAX_ROWS = 1000;       // rows read per lookup at most (the API refuses offset + limit > 10000)
const DEADLINE_MS = 45000;   // the whole call must finish in under 60 s

// Legal-form words, stripped from the END of both the typed name and the site's name before comparing.
const LEGAL_FORMS = new Set(['SAS', 'SASU', 'SA', 'SARL', 'EURL', 'SNC', 'SCI', 'SCA', 'SELARL', 'SELAS', 'SELURL', 'SEM', 'SCOP', 'GIE',
  'GMBH', 'AG', 'KG', 'LTD', 'LIMITED', 'LLC', 'LLP', 'INC', 'CORP', 'PLC', 'BV', 'NV', 'SRL', 'SPA', 'SL', 'SLU', 'SAU', 'SAL',
  'OY', 'AB', 'AS', 'APS', 'LDA']);

/** Upper-case, accents removed, dotted acronyms joined (S.A.S. -> SAS), punctuation to spaces. */
function fold(s) {
  return String(s || '')
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Normalised name without its legal form, e.g. "ACME TRADING SAS" -> "ACME TRADING". */
function core(s) {
  const t = fold(s).split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let sourceUrl = '';
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) });

  try {
    const kc = core(keyword);
    if (!kc) return fail('other', 'empty company name');

    const matches = [];
    let total = 0;
    let offset = 0;

    for (;;) {
      if (Date.now() - started > DEADLINE_MS) return fail('timeout', 'the lookup did not finish in time');

      const url = `${DATASET_URL}?where=${encodeURIComponent(`search(raison_sociale, "${kc}")`)}&limit=${PAGE}&offset=${offset}`;
      if (!sourceUrl) sourceUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

      let data;
      try { data = await res.json(); } catch { return fail('layout_changed', 'response is not JSON'); }
      if (!data || !Array.isArray(data.results) || typeof data.total_count !== 'number') {
        return fail('layout_changed', 'response has no results list');
      }

      total = data.total_count;
      for (const r of data.results) {
        const name = String(r.raison_sociale || '');
        if (core(name) === kc) matches.push({ name, site_id: String(r.id) });
      }

      if (data.results.length === 0) break;
      offset += data.results.length;
      if (offset >= total) break;
      if (offset >= MAX_ROWS) break;
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: `${matches.length} exact name match(es) for "${kc}" among ${Math.min(offset, total)} of ${total} search results`,
      };
    }

    // No exact match. If not every search result was read, the company could still be there: say so instead of not_found.
    if (offset < total) {
      return fail('other', `${total} similar entries for "${kc}", only the first ${offset} were checked, none with this exact name`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: total === 0
        ? `0 results for "${kc}"`
        : `${total} similar result(s) for "${kc}", none with this exact name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
