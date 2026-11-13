export const meta = {
  task: 'US-builtin.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'id', 'name_exact', 'profile_url', 'industries', 'headquarters', 'employees', 'website', 'description', 'profile_check'],
  canary: { found: 'McCain Foods', not_found: 'Zorvexa Quantum Holdings' },
};

const BASE = 'https://builtin.com';
const API = 'https://api.builtin.com';
const SITE_ID = 9;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Trailing legal forms that are ignored when comparing names (only at the end of a name).
const LEGAL = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc',
  'llp', 'lp', 'pllc', 'pc', 'gmbh', 'sa', 'ag', 'bv', 'nv', 'pte', 'bhd', 'sdn', 'pty']);

/** Normalised name: no accents, lower case, punctuation removed; optionally without the legal form. */
function normalize(name, stripLegal) {
  const words = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (stripLegal) {
    if (words.length > 1 && words[0] === 'the') words.shift();
    while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  }
  return words.join(' ');
}

/** The text sent to the search: the name without a trailing legal form, because the search finds nothing with one. */
function queryName(kw) {
  const words = kw.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL.has(normalize(words[words.length - 1], false))) words.pop();
  return words.join(' ').replace(/[\s,;:.]+$/, '');
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function get(url, accept) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept },
    signal: AbortSignal.timeout(25000),
  });
}

/** The schema.org Organization block that the profile page carries as JSON-LD. */
function findOrganization(html) {
  const re = /<script[^>]*type="application\/ld(?:\+|&#x2B;|&#x2b;)json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const list = Array.isArray(data) ? data : [data];
      const org = list.find((x) => x && x['@type'] === 'Organization');
      if (org) return org;
    } catch {
      // not valid JSON: try the next block
    }
  }
  return null;
}

/** One match from the search result, plus the profile page fields. Never throws. */
async function enrich(item, kw) {
  const rec = {
    name: item.title,
    id: item.id ?? null,
    name_exact: normalize(item.title, false) === normalize(kw, false),
    profile_url: new URL(item.alias, BASE).href,
    industries: item.industries || '',
    headquarters: '',
    employees: null,
    website: '',
    description: '',
    profile_check: 'not_read',
  };
  try {
    const res = await get(rec.profile_url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    if (!res.ok) {
      rec.profile_check = `HTTP ${res.status}`;
      return rec;
    }
    const org = findOrganization(await res.text());
    if (!org) {
      rec.profile_check = 'no organization data on profile page';
      return rec;
    }
    const a = org.address || {};
    rec.headquarters = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
      .filter(Boolean).join(', ');
    rec.employees = org.numberOfEmployees?.value ?? null;
    rec.website = org.url || '';
    rec.description = String(org.description || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    rec.profile_check = 'ok';
  } catch (err) {
    rec.profile_check = 'error: ' + String(err?.message || err).slice(0, 120);
  }
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword ?? '').trim();
  const query = queryName(kw);
  const searchUrl = `${API}/companyapi/search?query=${encodeURIComponent(query)}&siteid=${SITE_ID}&maxresults=10`;
  try {
    const want = normalize(kw, true);
    if (!want || !query) return failure('other', searchUrl, 'empty company name');

    const res = await get(searchUrl, 'application/json');
    if (res.status === 403 || res.status === 429) return failure('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', searchUrl, `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|cf-chl|access denied/i.test(text) && !text.trimStart().startsWith('[')) {
      return failure('blocked', searchUrl, text.slice(0, 200));
    }
    let items;
    try {
      items = JSON.parse(text);
    } catch {
      return failure('layout_changed', searchUrl, text.slice(0, 300));
    }
    if (!Array.isArray(items) || items.some((it) => !it || typeof it.title !== 'string' || typeof it.alias !== 'string')) {
      return failure('layout_changed', searchUrl, text.slice(0, 300));
    }

    const matches = items.filter((it) => normalize(it.title, true) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Built In search for "${kw}" returned ${items.length} result(s), none with this company name`,
      };
    }

    // Profile pages are read in parallel, so the total stays under the 60 s limit.
    const records = await Promise.all(matches.slice(0, 5).map((m) => enrich(m, kw)));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records[0].name} ${records[0].profile_url}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return failure(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
