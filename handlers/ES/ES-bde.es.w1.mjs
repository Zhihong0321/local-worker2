export const meta = {
  task: 'ES-bde.es',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'idelemento', 'codigo_be', 'tipo_persona', 'nif', 'lei', 'roles', 'nombres_comerciales', 'nombres_historicos'],
  canary: { found: 'BANCO SANTANDER, S.A.', not_found: 'EMPRESA FICTICIA NO REGISTRADA, S.L.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://app.bde.es/rbe_out/elementos';
const SITE = 'https://app.bde.es/rbe_spa/';
const MAX_PAGES = 15;        // the site returns 20 rows per page; 15 pages = 300 rows
const TIME_BUDGET_MS = 40000; // stay well under the 60 s limit

// Legal-form endings of Spanish company names, removed from the end of a name on both sides before comparing.
const LEGAL_SUFFIXES = [
  'S A U', 'S L U', 'S R L', 'S L N E', 'S C C L', 'S COOP', 'SOCIEDAD ANONIMA', 'SOCIEDAD LIMITADA',
  'SOCIEDAD COOPERATIVA', 'SAU', 'SLU', 'SRL', 'SLNE', 'SCCL', 'S A', 'S L', 'SA', 'SL', 'LTD', 'LIMITED', 'INC', 'LLC', 'GMBH',
];

/** Upper case, no accents, no punctuation, single spaces, legal form removed from the end. */
function coreName(s) {
  let w = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (w === suf || w.endsWith(' ' + suf)) {
        w = w.slice(0, w.length - suf.length).trim();
        changed = true;
        break;
      }
    }
  }
  return w;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

function docOf(entry, type) {
  const docs = (entry.documentos || []).filter((d) => d.tipoDocumento === type);
  const main = docs.find((d) => d.esPrincipal) || docs[0];
  return main ? String(main.numeroDocumento || '') : '';
}

/** Fetch one page of search results. Returns { data } or { fail } (a couldnt_check answer). */
async function fetchPage(core, page) {
  const url = `${API}?q=${encodeURIComponent(core)}&lang=es&page=${page}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { fail: fail(timedOut ? 'timeout' : 'other', url, e?.message || e) };
  }
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status}`) };

  let body;
  try {
    body = await res.text();
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { fail: fail(timedOut ? 'timeout' : 'other', url, e?.message || e) };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const low = body.slice(0, 2000).toLowerCase();
    if (low.includes('request rejected') || low.includes('captcha') || low.includes('access denied')) {
      return { fail: fail('blocked', url, body.slice(0, 200)) };
    }
    return { fail: fail('layout_changed', url, body.slice(0, 200)) };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.elementos) || typeof data.numResultados !== 'number') {
    return { fail: fail('layout_changed', url, body.slice(0, 200)) };
  }
  return { data, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Windows Node 24: a process that exits the instant a keep-alive socket to this host is still closing aborts
  // (libuv assertion, exit 127) after the answer is printed. A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  let searchUrl = SITE;
  try {
    const started = Date.now();
    const core = coreName(keyword);
    if (!core) return fail('other', SITE, 'no company name left after removing punctuation and legal form');

    // Page through the search results (the site's search matches all words of the query).
    const rows = [];
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > TIME_BUDGET_MS) return fail('timeout', searchUrl, 'search paging ran out of time');
      const got = await fetchPage(core, page);
      if (got.fail) return got.fail;
      searchUrl = got.url;
      total = got.data.numResultados;
      if (got.data.elementos.length === 0) break;
      rows.push(...got.data.elementos);
      if (rows.length >= total) break;
    }
    if (total === null) return fail('other', searchUrl, 'no search page was read');
    // If the site counts more rows than we could read, a match could be missing: do not call it not_found.
    if (rows.length < total) {
      return fail('other', searchUrl, `site reports ${total} results, read ${rows.length} (paging limit)`);
    }

    const matches = rows.filter((e) => coreName(e.nombre) === core);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${total} search result(s) for "${core}", none with this name`,
      };
    }

    const records = matches.map((e) => ({
      name: e.nombre || '',
      idelemento: e.idelemento ?? null,
      codigo_be: e.codigoBE || '',
      tipo_persona: e.tipoPersona || '',
      nif: docOf(e, 'NIF'),
      lei: docOf(e, 'LEI'),
      roles: (e.roles || []).map((r) => ({ role: r.nombreRol || '', end_date: r.fechaBajaRol || '' })),
      nombres_comerciales: e.nombreComerciales || [],
      nombres_historicos: e.nombresHistoricos || [],
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} match(es): ${records.map((r) => r.name).join(' | ')}`.slice(0, 300),
    };
  } catch (err) {
    return fail('other', searchUrl, err?.message || err);
  }
}
