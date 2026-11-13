export const meta = {
  task: 'DE-freelancermap.de',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'country', 'short_description', 'company_verified', 'profile_url'],
  canary: { found: 'TEICON Engineering GmbH', not_found: 'Wortschmiede Nordlicht Fantasie GmbH' },
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const SITE = 'https://www.freelancermap.de';
const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'kgaa', 'ug', 'ohg', 'se', 'mbh', 'co', 'gbr', 'ev', 'ltd', 'limited', 'inc', 'sarl', 'sas', 'bv', 'llc', 'sdn', 'bhd', 'plc', 'sa', 'pvt']);

/** Lower case, umlauts folded, punctuation and legal-form words removed: "TEICON Engineering GmbH" -> "teiconengineering". */
function normalize(str) {
  const folded = String(str || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  return folded.split(/[^a-z0-9]+/).filter((t) => t && !LEGAL.has(t)).join('');
}

/** The name without its legal form, keeping the user's spelling: "ACME Trading GmbH & Co. KG" -> "ACME Trading". */
function coreName(str) {
  return String(str || '').replace(/,/g, ' ').split(/\s+/)
    .filter((t) => { const n = normalize(t); return n && !LEGAL.has(t.toLowerCase().replace(/[^a-z0-9äöüß]/gi, '')); })
    .join(' ');
}

/** The search page carries its results as JSON in a React props tag named CompanyList. */
function readList(html) {
  const m = html.match(/data-component-name="CompanyList"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  let firstUrl = '';
  try {
    const input = String(keyword || '').trim();
    if (!input) return couldnt('other', SITE, 'empty company name');
    const want = normalize(input);
    if (!want) return couldnt('other', SITE, 'no usable letters in company name');

    const queries = [...new Set([input, coreName(input)].filter(Boolean))];
    for (const q of queries) {
      const base = `${SITE}/firmen?searchvalue=${encodeURIComponent(q)}`;
      if (!firstUrl) firstUrl = base;
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1 && (Date.now() - t0 > 30000 || total <= (page - 1) * PAGE_SIZE)) break;
        const url = page === 1 ? base : `${base}&pagenr=${page}`;
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
        if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

        const data = readList(await res.text());
        if (!data || !Array.isArray(data.companies) || typeof data.totalCount !== 'number') {
          return couldnt('layout_changed', url, 'CompanyList data not found on the search page');
        }
        total = data.totalCount;

        const matches = data.companies.filter((c) => normalize(c.name) === want);
        if (matches.length) {
          return {
            status: 'found',
            reason: '',
            records: matches.map((c) => ({
              name: c.name,
              city: c.city || '',
              country: c.country || '',
              short_description: c.shortDesc || '',
              company_verified: Boolean(c.companyVerified),
              profile_url: new URL(c.projectUrl, SITE).href,
            })),
            source_url: url,
            excerpt: `${matches.length} match(es) for "${q}" among ${total} results: ${matches[0].name}, ${matches[0].city || 'city not shown'}`,
          };
        }
        if (data.companies.length === 0 || total <= page * PAGE_SIZE) break;
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Search for "${input}" answered normally; no company with this name is listed`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', firstUrl || SITE, String(err?.message || err).slice(0, 300));
  }
}
