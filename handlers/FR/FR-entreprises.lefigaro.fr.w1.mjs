export const meta = {
  task: 'FR-entreprises.lefigaro.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'siren', 'town', 'url'],
  canary: { found: 'BPIFRANCE PARTICIPATIONS', not_found: 'Zqxvwkrt Inexistante' },
};

// One search request per lookup, read as HTML. A second request in the same process makes the Windows
// Node build used by the worker exit with an assertion (exit 127), so company pages are not read.
const BASE = 'https://entreprises.lefigaro.fr';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
};
const LEGAL_FORMS = ['sas', 'sasu', 'sarl', 'eurl', 'sa', 'sci', 'snc', 'scop', 'scs', 'selarl', 'selas', 'sel', 'se', 'sc', 'gie', 'ei'];
const PAGE_SIZE = 10;                 // the site lists 10 result rows per page
const MAX_PAGES = 3;                  // only the first 30 rows are read
const PAGE_START_LIMIT_MS = 25000;    // no further search page is started after this

const ENTITIES = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'", nbsp: ' ' };

function words(s) {
  return (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function dropLegalForm(list) {
  const out = list.slice();
  while (out.length > 1 && LEGAL_FORMS.includes(out[out.length - 1])) out.pop();
  return out;
}

/** Comparison key: case, accents, punctuation, spaces and a trailing legal form are ignored. */
function nameKey(name) {
  return dropLegalForm(words(name)).join('');
}

/** The search text: the keyword without its trailing legal form ("ACME SAS" -> "ACME"). */
function searchText(keyword) {
  const parts = keyword.trim().split(/\s+/);
  while (parts.length > 1 && LEGAL_FORMS.includes(words(parts[parts.length - 1]).join(''))) parts.pop();
  return parts.join(' ');
}

function clean(html) {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || '', excerpt: String(excerpt || '').slice(0, 300) };
}

/** GET a page. Returns { html } or { error: couldnt_check result }. Never throws. */
async function getPage(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: couldnt(t ? 'timeout' : 'other', url, e && e.message) };
  }
  if (res.status === 403 || res.status === 429) return { error: couldnt('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { error: couldnt('http_error', url, `HTTP ${res.status}`) };
  try {
    return { html: await res.text() };
  } catch (e) {
    const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: couldnt(t ? 'timeout' : 'other', url, e && e.message) };
  }
}

/** Rows of one search results page: one per result block. Villes and officers are kept but have no siren. */
function parseRows(html) {
  const rows = [];
  for (const block of html.split('<div class="od_search-result">').slice(1)) {
    const href = (block.match(/href="([^"]+)"/) || [])[1];
    if (!href) continue;
    const url = new URL(href.replace(/&amp;/g, '&'), BASE).href;
    const title = clean((block.match(/od_search-result__title">([\s\S]*?)<\/span>/) || [])[1]);
    const desc = clean((block.match(/od_search-result__desc">([\s\S]*?)<\/span>/) || [])[1]);
    const m = url.match(/\/entreprise-(\d+)\/?$/);
    rows.push({ url, title, desc, siren: m ? m[1] : '', key: m ? nameKey(title) : '' });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const name = String(keyword || '').trim();
    const key = nameKey(name);
    if (!key) return couldnt('other', '', 'empty company name');

    const query = searchText(name);
    let rowsRead = 0;
    let matches = [];
    let searchUrl = '';

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > PAGE_START_LIMIT_MS) {
        return couldnt('timeout', searchUrl, `only ${rowsRead} rows read before the time limit`);
      }
      searchUrl = `${BASE}/recherche?q=${encodeURIComponent(query)}` + (page > 1 ? `&page=${page}` : '');
      const got = await getPage(searchUrl);
      if (got.error) return got.error;

      const html = got.html;
      if (!html.includes('od_search-results')) {
        const bot = /captcha|cf-chl|challenge-platform|unusual traffic/i.test(html);
        return couldnt(bot ? 'blocked' : 'layout_changed', searchUrl, bot ? 'bot check page' : html.slice(0, 300));
      }

      const rows = parseRows(html);
      rowsRead += rows.length;
      matches = rows.filter(r => r.siren && r.key === key);
      if (matches.length) break;
      if (rows.length < PAGE_SIZE) break; // last page of results
    }

    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `no company named "${name}" among the ${rowsRead} search rows read`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.slice(0, 10).map(m => ({
        name: m.title,
        siren: m.siren,
        town: (m.desc.split('•')[1] || '').trim(),
        url: m.url,
      })),
      source_url: searchUrl,
      excerpt: matches.map(m => `${m.title} • ${m.desc}`).join(' | ').slice(0, 300),
    };
  } catch (err) {
    return couldnt('other', '', err && err.message);
  }
}
