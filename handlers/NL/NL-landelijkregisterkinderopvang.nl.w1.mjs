export const meta = {
  task: 'NL-landelijkregisterkinderopvang.nl',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'kvk_number', 'legal_form', 'street', 'house_number', 'postcode', 'city', 'geschillencommissie_start', 'holder_id', 'eenmanszaken_count'],
  canary: { found: 'Agrarische kinderopvang De Loeiende Koe', not_found: 'Zzqxwvb Kinderopvang Onbestaand' },
};

// Public holder search of the Landelijk Register Kinderopvang (the same JSON API the public site calls).
// GET /pp-api/v1/houders/?naam=<text>&pagina=<n>  -> { paginaAantal, houders: [{ houder: {...} }] }
// The site matches the text as a literal substring (case-insensitive) and keeps punctuation, so the
// handler searches the name without its trailing legal form and compares normalised names itself.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.landelijkregisterkinderopvang.nl/pp-api/v1/houders/';
const LEGAL_FORMS = new Set(['bv', 'nv', 'vof', 'cv', 'bvba', 'eenmanszaak', 'maatschap', 'cooperatie', 'coop', 'ltd', 'llc', 'gmbh', 'inc']);
const PAGE_CAP = 40;          // at most 40 result pages (600 holders) per query
const BATCH = 3;              // pages fetched in parallel
const START_LIMIT_MS = 25000; // no new request starts after 25 s, so the whole call stays under 60 s

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function key(s) {
  return fold(s).replace(/[^a-z0-9]/g, '');
}

/** Drop trailing legal-form words ("B.V.", "V.O.F.", "NV" ...). Prefix words such as "Stichting" stay. */
function stripLegalForm(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(key(tokens[tokens.length - 1]))) tokens.pop();
  return tokens.join(' ');
}

function nameKey(name) {
  return key(stripLegalForm(name));
}

/** The site stores apostrophes and quotes as plain ASCII; a typed curly one would find nothing. */
function queryVariants(core) {
  const straight = core.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  return [...new Set([core, straight])];
}

function toRecord(h) {
  const a = h.correspondentieAdres || {};
  return {
    name: h.naam || '',
    kvk_number: h.kvkNummer || '',
    legal_form: h.rechtsvorm || '',
    street: a.straat || '',
    house_number: a.huisnummer != null ? `${a.huisnummer}${a.letter || ''}` : '',
    postcode: a.postcode || '',
    city: a.plaats || '',
    geschillencommissie_start: h.datumStartGeschillencommissie || '',
    holder_id: h.identificatie || '',
    eenmanszaken_count: Array.isArray(h.eenmanszaken) ? h.eenmanszaken.length : 0,
  };
}

function fail(reason, url, excerpt) {
  return { fail: { reason, url, excerpt } };
}

async function fetchPage(query, page, started) {
  const url = `${BASE}?naam=${encodeURIComponent(query)}&pagina=${page}`;
  if (Date.now() - started > START_LIMIT_MS) return fail('other', url, 'not all search pages could be checked in time');
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/hal+json,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const looksBlocked = /captcha|challenge|access denied/i.test(text.slice(0, 5000));
      return fail(looksBlocked ? 'blocked' : 'layout_changed', url, text.slice(0, 300));
    }
    if (!data || typeof data.paginaAantal !== 'number' || !Array.isArray(data.houders)) {
      return fail('layout_changed', url, JSON.stringify(data).slice(0, 300));
    }
    return { data, url };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', url, String((err && err.message) || err).slice(0, 300));
  }
}

function pick(data, target, url) {
  const out = [];
  for (const item of data.houders) {
    const h = item && item.houder;
    if (h && h.naam && nameKey(h.naam) === target) out.push({ holder: h, url });
  }
  return out;
}

/** Walks every result page of one query (within limits). Returns matches, whether all pages were checked, and any failure. */
async function searchAll(query, target, started) {
  const first = await fetchPage(query, 1, started);
  if (first.fail) return { matches: [], complete: false, problem: first.fail };
  const matches = pick(first.data, target, first.url);
  const totalPages = first.data.paginaAantal;
  const last = Math.min(totalPages, PAGE_CAP);
  let complete = totalPages <= PAGE_CAP;
  let problem = null;
  let next = 2;
  while (next <= last) {
    const batch = [];
    while (batch.length < BATCH && next <= last) batch.push(next++);
    const results = await Promise.all(batch.map((p) => fetchPage(query, p, started)));
    for (const r of results) {
      if (r.fail) { complete = false; problem = problem || r.fail; continue; }
      matches.push(...pick(r.data, target, r.url));
    }
    if (problem) break;
  }
  return { matches, complete, problem };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await searchOnce(keyword);
  // Node 24 on Windows asserts ("UV_HANDLE_CLOSING", exit 127) when the process exits right after a fetch that
  // used AbortSignal.timeout. A short pause lets the sockets close first. Found by running try.mjs repeatedly.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return answer;
}

async function searchOnce(keyword) {
  try {
    const core = stripLegalForm(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name to search for' };
    }
    const target = nameKey(keyword);
    const started = Date.now();
    let complete = true;
    let problem = null;

    for (const query of queryVariants(core)) {
      const r = await searchAll(query, target, started);
      if (r.matches.length > 0) {
        return {
          status: 'found',
          reason: '',
          records: r.matches.map((m) => toRecord(m.holder)),
          source_url: r.matches[0].url,
          excerpt: JSON.stringify(toRecord(r.matches[0].holder)).slice(0, 500),
        };
      }
      if (!r.complete) complete = false;
      if (r.problem && !problem) problem = r.problem;
    }

    if (problem) {
      return { status: 'couldnt_check', reason: problem.reason, records: [], source_url: problem.url, excerpt: problem.excerpt };
    }
    if (!complete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'too many search results to check every page in time' };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}?naam=${encodeURIComponent(core)}&pagina=1`,
      excerpt: `0 holders with the name "${core}" on the register`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
