export const meta = {
  task: 'FR-journal-officiel.gouv.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'siren', 'dateparution', 'numero_affaire', 'bulletin', 'category', 'id_annonce', 'announcement_url'],
  canary: { found: 'AETHER FINANCIAL SERVICES', not_found: 'SOCIETE INEXISTANTE ZORGLUB' },
};

// BALO is an Opendatasoft (Huwise) explore portal. Its public, anonymous v2.1 records API is what the site's own
// search page calls. The search is an AND of the words typed, so the legal form is removed before searching.
const DATASET = 'https://www.journal-officiel.gouv.fr/api/explore/v2.1/catalog/datasets/balo/records';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SELECT = 'id_annonce,dateparution,societes_noms,siren,numero_affaire,num_bulletin,facette_categorie_libelle,ftcontent';
const PAGE = 100;
// Two requests of at most 25 s each keeps the whole call under 60 s.
const MAX_PAGES = 2;
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sa', 'sarl', 'eurl', 'snc', 'sci', 'sca', 'scop', 'se', 'sem', 'sasp', 'gie',
  'scs', 'sc', 'gmbh', 'ag', 'ltd', 'limited', 'plc', 'inc', 'llc', 'nv', 'bv', 'srl', 'spa', 'llp']);

/** Normalised company name: no accents, no dots, no punctuation, no trailing legal form, lower case. */
function nameKey(name) {
  const tokens = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (tokens.length && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function searchUrl(key, offset) {
  const where = `search(societes_noms,"${key}")`;
  return `${DATASET}?limit=${PAGE}&offset=${offset}&order_by=dateparution%20desc` +
    `&select=${SELECT}&where=${encodeURIComponent(where)}`;
}

function toRecord(row, key) {
  const names = Array.isArray(row.societes_noms) ? row.societes_noms : [row.societes_noms];
  const idx = names.findIndex((n) => nameKey(n) === key);
  const sirens = Array.isArray(row.siren) ? row.siren : [row.siren];
  // Only report a SIREN when the list of names and the list of SIRENs line up one to one.
  const siren = sirens.length === names.length && idx >= 0 ? String(sirens[idx] || '') : '';
  const id = String(row.id_annonce || '');
  return {
    name: idx >= 0 ? String(names[idx]) : '',
    siren,
    dateparution: String(row.dateparution || ''),
    numero_affaire: String(row.numero_affaire || ''),
    bulletin: String(row.num_bulletin || ''),
    category: String(row.facette_categorie_libelle || '').replace(/##/g, ' - '),
    id_annonce: id,
    announcement_url: id ? `https://www.journal-officiel.gouv.fr/pages/balo-annonce-unitaire?q.id=id_annonce:${id}` : '',
  };
}

const out = (status, reason, records, source_url, excerpt) => ({ status, reason, records, source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let firstUrl = DATASET;
  try {
    const key = nameKey(keyword);
    if (!key) return out('couldnt_check', 'other', [], DATASET, 'no company name left after removing the legal form');
    firstUrl = searchUrl(key, 0);

    const records = [];
    let total = 0;
    let scanned = 0;
    let firstText = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = searchUrl(key, page * PAGE);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', [], firstUrl, `HTTP ${res.status}`);
      if (!res.ok) return out('couldnt_check', 'http_error', [], firstUrl, `HTTP ${res.status}`);

      let body;
      try { body = await res.json(); } catch (e) { body = null; }
      if (!body || !Array.isArray(body.results) || typeof body.total_count !== 'number') {
        return out('couldnt_check', 'layout_changed', [], firstUrl, JSON.stringify(body || '').slice(0, 300));
      }
      total = body.total_count;
      scanned += body.results.length;
      for (const row of body.results) {
        const names = Array.isArray(row.societes_noms) ? row.societes_noms : [row.societes_noms];
        if (names.some((n) => nameKey(n) === key)) {
          if (!firstText) firstText = String(row.ftcontent || '');
          records.push(toRecord(row, key));
        }
      }
      if (body.results.length < PAGE || scanned >= total) break;
    }

    if (records.length) {
      const note = scanned < total ? ` (newest ${scanned} of ${total} search hits scanned)` : '';
      return out('found', '', records, firstUrl, firstText.slice(0, 400) + note);
    }
    if (scanned >= total) {
      return out('not_found', '', [], firstUrl, `0 matching announcements among ${total} search hits`);
    }
    // Too many hits to read them all, and none matched in the newest ones: the answer is not known.
    return out('couldnt_check', 'other', [], firstUrl,
      `${total} search hits, none matched in the newest ${scanned}; not all hits could be read`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timedOut ? 'timeout' : 'other', [], firstUrl, String((err && err.message) || err).slice(0, 300));
  }
}
