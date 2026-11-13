export const meta = {
  task: 'NL-freelance.nl',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['id', 'name', 'profile_url', 'address_line1', 'postal_code', 'city', 'country_code', 'registered_since', 'website', 'detail'],
  canary: { found: 'Elevation Partners', not_found: 'Onbestaande Onderneming Zzqxwv B.V.' },
};

const SITE = 'https://www.freelance.nl';
const API_URL = `${SITE}/public-api`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 16; // the site's company guide shows 16 per page
const MAX_PAGES = 8; // 128 results at most; more than that is couldnt_check, never a guess
const DETAIL_CUTOFF_MS = 30000; // profile pages are read only if the search was quick, so the call stays under 60 s

// Same query the site's own company guide sends to /public-api.
const QUERY = 'query getCompanies($page: Int!, $searchTerm: String) { count: publicCompaniesCount(searchTerm: $searchTerm) publicCompanies(page: $page, searchTerm: $searchTerm) { id name } }';

// Legal-form words. The site's search returns 0 when the legal form is typed ("Elevation Partners B.V." -> 0),
// so the search uses the name without it, and the match compares names without it.
const LEGAL_FORMS = new Set(['bv', 'nv', 'vof', 'cv', 'bvba', 'eenmanszaak', 'stichting', 'ltd', 'llc', 'gmbh']);

function fail(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

function words(name) {
  return String(name || '').replace(/\./g, '').split(/\s+/).filter(Boolean);
}

function coreWords(name) {
  const w = words(name);
  while (w.length > 1 && LEGAL_FORMS.has(w[w.length - 1].toLowerCase())) w.pop();
  return w;
}

function normKey(name) {
  return coreWords(name).join('').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function decode(v) {
  return String(v).replace(/\\u0026/g, '&').replace(/\\u002F/g, '/').replace(/&amp;/g, '&').trim();
}

/** One page of the site's company search. Returns { count, list } or { fail }. */
async function searchPage(term, page) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { page, searchTerm: term } }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', `HTTP ${res.status}`, API_URL) };
  if (!res.ok) return { fail: fail('http_error', `HTTP ${res.status}`, API_URL) };
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: a bot check or login wall is blocked; anything else is a changed layout.
    if (/captcha|challenge|access denied|log in|inloggen/i.test(text.slice(0, 3000))) return { fail: fail('blocked', 'bot or login check page', API_URL) };
    return { fail: fail('layout_changed', 'not JSON: ' + text.slice(0, 200), API_URL) };
  }
  const d = json && json.data;
  if (json.errors || !d || typeof d.count !== 'number' || !Array.isArray(d.publicCompanies)) {
    return { fail: fail('layout_changed', 'unexpected answer: ' + text.slice(0, 200), API_URL) };
  }
  return { count: d.count, list: d.publicCompanies };
}

/** Reads the company's profile page for address and dates. Best effort: a failure keeps the search fields. */
async function profile(c, go) {
  const url = `${SITE}/profiel/${c.id}-${slug(c.name)}`;
  const base = { id: c.id, name: c.name, profile_url: url, address_line1: '', postal_code: '', city: '', country_code: '', registered_since: '', website: '', detail: '' };
  if (!go) return { ...base, detail: 'skipped: search was slow' };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { ...base, detail: `profile HTTP ${res.status}` };
    const s = (await res.text()).replace(/\\"/g, '"');
    const at = s.indexOf('"name":' + JSON.stringify(c.name));
    if (at < 0) return { ...base, detail: 'profile layout changed: company block not found' };
    const seg = s.slice(at, at + 3000);
    const pick = (key) => {
      const m = seg.match(new RegExp('"' + key + '":"([^"]*)"'));
      return m ? decode(m[1]) : '';
    };
    const addr = seg.match(/"address":\{([^}]*)\}/);
    const addrPick = (key) => {
      const m = addr && addr[1].match(new RegExp('"' + key + '":"([^"]*)"'));
      return m ? decode(m[1]) : '';
    };
    return {
      ...base,
      address_line1: addrPick('addressLine1'),
      postal_code: addrPick('postalCode'),
      city: addrPick('city'),
      country_code: addrPick('countryCode'),
      registered_since: pick('createdAt'),
      website: pick('websiteUrl'),
      detail: 'ok',
    };
  } catch (e) {
    return { ...base, detail: `profile ${e?.name === 'TimeoutError' ? 'timeout' : 'error'}: ${String(e?.message || e).slice(0, 120)}` };
  }
}

async function lookupOnce(keyword) {
  const t0 = Date.now();
  try {
    const term = coreWords(keyword).join(' ');
    if (!term) return fail('other', 'empty company name', API_URL);
    const want = normKey(keyword);

    const first = await searchPage(term, 1);
    if (first.fail) return first.fail;
    if (first.count > MAX_PAGES * PAGE_SIZE) {
      return fail('other', `${first.count} results for "${term}": more than ${MAX_PAGES * PAGE_SIZE}, not checked in one run`, API_URL);
    }

    let hits = first.list.slice();
    let failure = null;
    const pages = Math.ceil(first.count / PAGE_SIZE);
    if (pages > 1) {
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => searchPage(term, i + 2)));
      for (const r of rest) {
        if (r.fail) failure = failure || r.fail;
        else hits = hits.concat(r.list);
      }
    }

    const matches = [];
    for (const c of hits) {
      if (normKey(c.name) === want && !matches.some((m) => m.id === c.id)) matches.push(c);
    }

    if (matches.length === 0) {
      if (failure) return failure;
      const closest = hits.slice(0, 3).map((c) => c.name).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: API_URL,
        excerpt: `0 exact matches for "${keyword}" (searched "${term}": ${first.count} results)${closest ? '; first results: ' + closest : ''}`,
      };
    }

    const go = Date.now() - t0 < DETAIL_CUTOFF_MS;
    const records = await Promise.all(matches.slice(0, 3).map((c) => profile(c, go)));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url,
      excerpt: `${matches.length} exact match(es) for "${keyword}" in the freelance.nl company guide (search "${term}": ${first.count} results)`,
    };
  } catch (e) {
    return fail(e?.name === 'TimeoutError' ? 'timeout' : 'other', 'the handler threw: ' + String(e?.message || e), API_URL);
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await lookupOnce(keyword);
  } catch (e) {
    answer = fail('other', 'the handler threw: ' + String(e?.message || e), API_URL);
  }
  // Windows Node can abort on process.exit while a keep-alive socket is still closing (libuv assertion, exit 127).
  // A short pause after the last request lets the socket close first. Nothing else depends on it.
  await new Promise((r) => setTimeout(r, 400));
  return answer;
}
