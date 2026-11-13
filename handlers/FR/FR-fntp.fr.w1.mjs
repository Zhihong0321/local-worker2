export const meta = {
  task: 'FR-fntp.fr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'siret', 'num_siren', 'num_tp', 'agence', 'address', 'postal_code', 'city', 'phone', 'website', 'email'],
  canary: { found: 'EIFFAGE CONSTRUCTION MATERIEL', not_found: 'Zzqxyy Boulangerie Imaginaire SARL' },
};

// The FNTP annuaire page (https://www.fntp.fr/annuaire/) embeds the company directory from rip.fntp.fr.
// Its results page loads rows from GET /rip/paginer (JSON, 12 rows per page, sorted by name, empty array = no rows).
const BASE = 'https://rip.fntp.fr/rip';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 30;      // about 360 rows at most
const START_NEW_PAGE_BEFORE_MS = 30000; // a page fetch can take up to 25 s, so the whole call stays under 60 s

// French legal-form words. They are removed before searching and before comparing names.
const LEGAL_FORMS = new Set(['SAS', 'SASU', 'SARL', 'EURL', 'SA', 'SNC', 'SCI', 'SCOP', 'SELARL', 'SELAS', 'SCM', 'SCA', 'SE', 'EI', 'GIE', 'SEM', 'SPL', 'SCIC']);

class CheckError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** Upper-case words without accents or punctuation. */
function tokens(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** The name without legal-form words; if nothing is left, the whole name. */
function coreTokens(str) {
  const all = tokens(str);
  const core = all.filter((w) => !LEGAL_FORMS.has(w));
  return core.length ? core : all;
}

/** Same company when the normalised names (case, accents, punctuation, legal form) are equal. */
function sameCompany(keyword, listedName) {
  const a = coreTokens(keyword).join('');
  const b = coreTokens(listedName).join('');
  return a !== '' && a === b;
}

async function getPage(term, page, pageUrl) {
  const url = `${BASE}/paginer?` + new URLSearchParams({ tri: 'NOM', raison_sociale: term, selected_page: String(page) }).toString();
  let text;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': pageUrl,
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) throw new CheckError('blocked', `HTTP ${res.status} on page ${page}`);
    if (!res.ok) throw new CheckError('http_error', `HTTP ${res.status} on page ${page}`);
    text = await res.text();
  } catch (err) {
    if (err instanceof CheckError) throw err;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new CheckError(timedOut ? 'timeout' : 'other', String(err?.message || err));
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (/captcha|cloudflare|access denied|forbidden/i.test(text)) throw new CheckError('blocked', 'bot or captcha page: ' + text.slice(0, 200));
    throw new CheckError('layout_changed', 'not JSON on page ' + page + ': ' + text.slice(0, 200));
  }
  if (!Array.isArray(data) || data.some((r) => !r || typeof r.raison_sociale !== 'string')) {
    throw new CheckError('layout_changed', 'unexpected JSON on page ' + page + ': ' + text.slice(0, 200));
  }
  return data;
}

function toRecord(r) {
  return {
    name: (r.raison_sociale || '').trim(),
    siret: r.siret || '',
    num_siren: r.num_siren || '',
    num_tp: r.num_tp != null ? String(r.num_tp) : '',
    agence: r.agence === true || r.agence === 'true',
    address: [r.adresse1, r.adresse2].map((s) => (s || '').trim()).filter(Boolean).join(', '),
    postal_code: (r.code_postal || '').trim(),
    city: (r.ville || '').trim(),
    phone: (r.telephone || '').trim(),
    website: (r.site || '').trim(),
    email: (r.email || '').trim(),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Node on Windows can abort at exit while a keep-alive socket from the last fetch is still closing
  // (libuv assertion, exit code 127, after the answer was printed). A short pause lets the sockets close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  const term = coreTokens(keyword).join(' ');
  const sourceUrl = `${BASE}/rechercher?raison_sociale=${encodeURIComponent(term)}`;
  try {
    if (!term) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'empty company name' };
    }

    const matches = [];
    let rowsRead = 0;
    let pagesRead = 0;
    let stoppedBy = null; // set when the read was cut short before the last page

    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        stoppedBy = new CheckError('other', `search has more than ${MAX_PAGES} pages; read stopped`);
        break;
      }
      if (Date.now() - started > START_NEW_PAGE_BEFORE_MS) {
        stoppedBy = new CheckError('timeout', `read stopped after ${pagesRead} pages to stay under 60 s`);
        break;
      }
      let rows;
      try {
        rows = await getPage(term, page, sourceUrl);
      } catch (err) {
        stoppedBy = err;
        break;
      }
      if (rows.length === 0) break; // last page reached
      pagesRead = page;
      rowsRead += rows.length;
      for (const r of rows) {
        if (sameCompany(keyword, r.raison_sociale)) matches.push(r);
      }
    }

    if (matches.length > 0) {
      const summary = matches.map((r) => `${r.raison_sociale} | ${r.code_postal} ${r.ville} | TP ${r.num_tp}`).join('; ');
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: sourceUrl,
        excerpt: summary.slice(0, 500),
      };
    }
    if (stoppedBy) {
      return { status: 'couldnt_check', reason: stoppedBy.reason, records: [], source_url: sourceUrl, excerpt: String(stoppedBy.message).slice(0, 300) };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `0 exact matches for "${keyword}" (search "${term}" read ${rowsRead} rows on ${pagesRead} pages)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
