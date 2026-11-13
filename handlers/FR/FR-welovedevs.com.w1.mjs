export const meta = {
  task: 'FR-welovedevs.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'address', 'postal_code', 'city', 'employees', 'founded', 'website', 'url'],
  canary: { found: 'Listen Too', not_found: 'Quincaillerie Morvan Ferrand' },
};

const BASE = 'https://welovedevs.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};
// Legal forms are dropped before comparing names ("OLYMPP SAS" = "Olympp").
const LEGAL = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'snc', 'sci', 'ei', 'ltd', 'limited', 'inc', 'llc',
  'gmbh', 'sl', 'srl', 'bv', 'ag', 'plc', 'corp', 'co', 'sdn', 'bhd', 'pte', 'pty']);
const MAX_UNNAMED_DETAILS = 5;

function decode(s) {
  return String(s || '')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(name) {
  return decode(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Comparison key: lower case, no accents, no punctuation, no legal form. */
function core(name) {
  const w = words(name);
  const kept = w.filter((x) => !LEGAL.has(x));
  return (kept.length ? kept : w).join('');
}

/** The search text: the name as typed, without the legal form words. */
function searchText(input) {
  const kept = input.split(/\s+/).filter((x) => x && !LEGAL.has(words(x).join('')));
  return kept.length ? kept.join(' ') : input;
}

/** Result cards on the search page: one per company link, with the name from the gallery image alt text. */
function parseCards(html) {
  const parts = html.split('class="contents" href="/app/fr/company/').slice(1);
  const cards = [];
  const seen = new Set();
  for (const part of parts) {
    const m = part.match(/^([a-z0-9-]+)"/i);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const alt = part.slice(0, 1500).match(/alt="([^"]*?) gallery image"/);
    cards.push({ slug: m[1], name: alt ? decode(alt[1]) : '' });
  }
  return cards;
}

/** Company page: name in the <h1>, address in the schema.org JSON-LD, size, founding year and website in the embedded data. */
function parseDetail(html) {
  const out = { name: '', address: '', postal_code: '', city: '', employees: '', founded: '', website: '' };
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) out.name = decode(h1[1].replace(/<[^>]+>/g, ' '));
  for (const b of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j;
    try { j = JSON.parse(b[1]); } catch (e) { continue; }
    if (j && j['@type'] === 'Organization' && j.location && j.location.address) {
      const a = j.location.address;
      out.address = a.streetAddress || '';
      out.postal_code = a.postalCode || '';
      out.city = a.addressLocality || '';
      if (!out.name && j.brand && j.brand.name) out.name = decode(j.brand.name);
    }
  }
  const emp = html.match(/"employeesCount":"([^"]*)"/);
  if (emp) out.employees = emp[1];
  const fy = html.match(/"fundedIn":"([^"]*)"/);
  if (fy) out.founded = fy[1];
  const web = html.match(/"details":\{[\s\S]{0,800}?"url":"([^"]*)"/);
  if (web) out.website = web[1];
  return out;
}

async function fetchDetail(slug) {
  try {
    const res = await fetch(`${BASE}/app/fr/company/${slug}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { ok: false };
    return { ok: true, data: parseDetail(await res.text()) };
  } catch (e) {
    return { ok: false };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const searchUrl = `${BASE}/app/fr/companies?query=${encodeURIComponent(searchText(input))}`;
  try {
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    const hasResults = /entreprises?\s+trouv/i.test(html);
    const isEmpty = /entreprise de vos r\S+ves arrive/i.test(html);

    if (res.status === 200 && !hasResults && isEmpty) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'the site shows its "company not listed yet" page' };
    }
    if (res.status === 403 || res.status === 429 || (!hasResults && /captcha|just a moment|cf-chl|access denied/i.test(html))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!hasResults) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: decode(html.replace(/<[^>]+>/g, ' ')).slice(0, 300) };
    }

    const cards = parseCards(html);
    const target = core(input);
    const named = cards.filter((c) => c.name);
    const unnamed = cards.filter((c) => !c.name);
    // Cards without a readable name are checked on their company page, a few at most, all in parallel.
    const unnamedToCheck = unnamed.slice(0, MAX_UNNAMED_DETAILS);
    let unresolved = unnamed.length - unnamedToCheck.length;

    const toFetch = [...named.filter((c) => core(c.name) === target), ...unnamedToCheck];
    const details = await Promise.all(toFetch.map((c) => fetchDetail(c.slug)));

    const records = [];
    toFetch.forEach((c, i) => {
      const d = details[i];
      if (!c.name && !d.ok) { unresolved++; return; }
      const name = c.name || d.data.name;
      if (!name || core(name) !== target) return;
      const data = d.ok ? d.data : null;
      records.push({
        name: data && data.name ? data.name : name,
        slug: c.slug,
        url: `${BASE}/app/fr/company/${c.slug}`,
        address: data ? data.address : '',
        postal_code: data ? data.postal_code : '',
        city: data ? data.city : '',
        employees: data ? data.employees : '',
        founded: data ? data.founded : '',
        website: data ? data.website : '',
      });
    });

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].url,
        excerpt: `${records[0].name}, ${records[0].postal_code} ${records[0].city}`.trim(),
      };
    }
    if (unresolved > 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: `${unresolved} listing(s) on the results page could not be read` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `${cards.length} listing(s) on the results page, none named "${input}"` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
