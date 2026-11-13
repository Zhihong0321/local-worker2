export const meta = {
  task: 'FR-cre.fr',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['title', 'document_type', 'date', 'url'],
  canary: { found: 'HELLIO SOLUTIONS', not_found: 'Zorvlex Énergie Fictive SAS' },
};

// The CRE site search (/recherche.html?tx_solr[...]) and every other URL with a query string answer 403 with a
// Cloudflare challenge, so this handler does not use the search. It reads the public sitemap (plain URLs, 200 OK),
// which lists every CRE page address. A company is "found" when its name appears in one of those page addresses
// (deliberations on authorisations to supply electricity or gas, CoRDiS dispute decisions, press releases), and then
// the page itself is read for its title and deliberation date.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const INDEX_URL = 'https://www.cre.fr/sitemap.xml';
const MAX_DETAIL_PAGES = 5;
const MIN_SITEMAP_URLS = 100;
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sa', 'sarl', 'eurl', 'snc', 'sci', 'scop', 'sca', 'gie', 'ste', 'societe', 'cie']);
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“',
  rdquo: '”', ndash: '–', mdash: '—', hellip: '…', euro: '€', eacute: 'é', egrave: 'è',
  ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô',
  ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', oelig: 'œ', Eacute: 'É', Egrave: 'È',
  Agrave: 'À', Ccedil: 'Ç', Ocirc: 'Ô', Ucirc: 'Û',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lower-case word tokens, accents and punctuation removed. */
function tokens(s) {
  return stripAccents(decodeEntities(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Name words without the legal form, e.g. "HELLIO SOLUTIONS SAS" -> ["hellio", "solutions"]. */
function nameTokens(s) {
  return tokens(s).filter((t) => !LEGAL_FORMS.has(t));
}

// Words that may follow a company name in a page address ("...-societe-enedis-relatif-au-...", "...-pour-revente").
const CONNECTORS = new Set(['a', 'au', 'aux', 'd', 'de', 'des', 'du', 'l', 'la', 'le', 'les', 'en', 'et', 'ou', 'pour',
  'sur', 'dans', 'par', 'avec', 'contre', 'entre', 'qui', 'que', 'relatif', 'relative', 'relatives', 'concernant',
  'portant', 'selon', 'suite', 'fixant', 'modifiant', 'apres']);

/**
 * 'exact'     the name is followed by the end, a legal form, a connector or a number: the name is the whole name
 * 'continues' the name is followed by another name word ("HELLIO" inside "HELLIO SOLUTIONS"): not a confirmed match
 * null        the name words do not occur
 */
function matchKind(list, run) {
  if (run.length === 0) return null;
  let continues = false;
  for (let i = 0; i + run.length <= list.length; i++) {
    let same = true;
    for (let j = 0; j < run.length; j++) {
      if (list[i + j] !== run[j]) { same = false; break; }
    }
    if (!same) continue;
    const next = list[i + run.length];
    if (next === undefined || LEGAL_FORMS.has(next) || CONNECTORS.has(next) || /^\d+$/.test(next)) return 'exact';
    continues = true;
  }
  return continues ? 'continues' : null;
}

function slugOf(url) {
  const path = url.replace(/[?#].*$/, '');
  const last = path.split('/').pop() || '';
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch (e) { /* keep raw */ }
  return decoded.replace(/\.html?$/i, '');
}

function documentType(url) {
  if (url.includes('/documents/deliberations/')) return 'deliberation';
  if (url.includes('/documents/decisions-du-cordis/')) return 'cordis_decision';
  if (url.includes('/actualites/')) return 'news';
  if (url.includes('/documents/communiques-de-presse/')) return 'press_release';
  return 'page';
}

function isBlocked(res, body) {
  return res.status === 403 || res.status === 429 || /challenge-platform|cf-chl|Just a moment/i.test(body || '');
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml,text/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.text();
  return { res, body };
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 500) };
}

function locs(xml) {
  return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeEntities(m[1].trim()));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = nameTokens(keyword);
    if (kw.length === 0) return couldnt('other', INDEX_URL, 'no name words in the keyword');

    // 1. Sitemap index -> the sitemap pages that list every CRE address.
    const idx = await get(INDEX_URL);
    if (isBlocked(idx.res, idx.body)) return couldnt('blocked', INDEX_URL, `HTTP ${idx.res.status}`);
    if (!idx.res.ok) return couldnt('http_error', INDEX_URL, `HTTP ${idx.res.status}`);
    const subUrls = locs(idx.body).filter((u) => /sitemap=pages/.test(u) && /sitemap\.xml\?/.test(u));
    if (subUrls.length === 0) return couldnt('layout_changed', INDEX_URL, idx.body.slice(0, 300));

    // 2. Every sitemap page. A failed page means the list is incomplete, so no "not found" is possible.
    const subs = await Promise.all(subUrls.map((u) => get(u).then((r) => ({ url: u, ...r }), (e) => ({ url: u, error: e }))));
    for (const s of subs) {
      if (s.error) {
        const reason = s.error && s.error.name === 'TimeoutError' ? 'timeout' : 'other';
        return couldnt(reason, s.url, String(s.error && s.error.message || s.error));
      }
      if (isBlocked(s.res, s.body)) return couldnt('blocked', s.url, `HTTP ${s.res.status}`);
      if (!s.res.ok) return couldnt('http_error', s.url, `HTTP ${s.res.status}`);
      if (!/<urlset/i.test(s.body)) return couldnt('layout_changed', s.url, s.body.slice(0, 300));
    }
    const pageUrls = subs.flatMap((s) => locs(s.body));
    if (pageUrls.length < MIN_SITEMAP_URLS) return couldnt('layout_changed', INDEX_URL, `only ${pageUrls.length} page addresses`);

    // 3. Company name words as a whole run inside the page address (word boundaries are the hyphens).
    const hits = [];
    const longer = [];
    for (const u of pageUrls) {
      const kind = matchKind(tokens(slugOf(u)), kw);
      if (kind === 'exact') hits.push(u);
      else if (kind === 'continues') longer.push(u);
    }
    if (hits.length === 0 && longer.length > 0) {
      // The name only appears as the start of a longer company name: the same name cannot be confirmed.
      return couldnt('other', longer[0], `"${keyword}" appears only inside longer names in the page addresses ` +
        `(e.g. ${slugOf(longer[0])}); not confirmed as the same company`);
    }
    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: INDEX_URL,
        excerpt: `No CRE page address in the sitemap (${pageUrls.length} addresses) contains "${keyword}"`,
      };
    }

    // 4. Read the matching pages for their title and deliberation date (time-guarded).
    const chosen = hits.slice(0, MAX_DETAIL_PAGES);
    const details = await Promise.all(chosen.map((u) => (Date.now() - started < 35000
      ? get(u).catch(() => null) : Promise.resolve(null))));
    const records = chosen.map((u, i) => {
      const d = details[i];
      let title = '';
      let date = '';
      if (d && d.res.ok && !isBlocked(d.res, d.body)) {
        const t = d.body.match(/<title>([^<]*)<\/title>/i);
        title = t ? decodeEntities(t[1]).replace(/\s*\|\s*CRE\s*$/i, '').replace(/\s+/g, ' ').trim() : '';
        const text = decodeEntities(d.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
        const dm = text.match(/(?:Délibération|Décision)[\s\S]{0,80}? du (\d{1,2}(?:er)? [^\s]+ \d{4})/);
        date = dm ? dm[1] : '';
      }
      return { title, document_type: documentType(u), date, url: u };
    });

    const first = records[0];
    const titles = records.map((r) => r.title || slugOf(r.url)).join(' | ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.url,
      excerpt: `${hits.length} CRE page(s) name this company: ${titles}`.slice(0, 500),
    };
  } catch (err) {
    return couldnt(err && err.name === 'TimeoutError' ? 'timeout' : 'other', INDEX_URL, String((err && err.message) || err));
  }
}
