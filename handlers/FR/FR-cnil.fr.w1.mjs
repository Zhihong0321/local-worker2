export const meta = {
  task: 'FR-cnil.fr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'reference', 'date', 'kind', 'url', 'summary'],
  canary: { found: 'SOCIETE DU FIGARO', not_found: 'Nexavaldrie Immobilier SARL' },
};

// CNIL's own search (Drupal). `search` = full-text query; type 1 = articles, 2 and 3 = deliberations.
const SEARCH = 'https://www.cnil.fr/fr/recherche';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'snc', 'sci', 'sca', 'sce', 'ltd', 'limited', 'llc', 'gmbh', 'plc', 'inc', 'srl', 'bv', 'ag']);
const MAX_PAGES = 8;          // 10 results per page: 80 results read at most
const DEADLINE_MS = 45000;    // stay well under the 60 s limit

const ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  ndash: '-', mdash: '-', laquo: '"', raquo: '"', euro: '€', eacute: 'é', Eacute: 'É', egrave: 'è', ecirc: 'ê', agrave: 'à',
  ccedil: 'ç', ocirc: 'ô', ucirc: 'û', icirc: 'î', acirc: 'â', iuml: 'ï', euml: 'ë', oelig: 'œ', OElig: 'Œ' };

function decode(s) {
  return String(s || '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised word list: no accents, no case, no punctuation. */
function tokens(s) {
  return decode(s).replace(/œ/gi, 'oe').replace(/æ/gi, 'ae').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** True when the needle words appear as one contiguous run inside the haystack words. */
function containsSeq(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function searchUrl(keyword, page) {
  const u = new URL(SEARCH);
  u.searchParams.set('search', keyword);
  u.searchParams.set('type[1]', '1');
  u.searchParams.set('type[2]', '2');
  u.searchParams.set('type[3]', '3');
  if (page > 0) u.searchParams.set('page', String(page));
  return u.href;
}

/** Result count shown by the search page, or null when the count is missing (page not as expected). */
function totalCount(html) {
  const i = html.indexOf('views-record-count-text');
  if (i < 0) return null;
  const m = html.slice(i, i + 300).match(/(\d+)(?:<\/strong>)?\s*r[ée]sultats?\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseRows(html) {
  const out = [];
  for (const chunk of html.split('<div class="views-row">').slice(1)) {
    const h = chunk.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h) continue;
    const intro = chunk.match(/class=['"][^'"]*\bintroduction\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i);
    out.push({ href: decode(h[1]), title: clean(h[2]), intro: intro ? clean(intro[1]) : '', chunk });
  }
  return out;
}

/** Keeps only sanction-type items: restricted-committee sanctions (SAN-), formal notices (MED-), or articles tagged as such. */
function classify(title, chunk) {
  if (/\bSAN\s*[-–]\s*\d{4}/i.test(title)) return 'sanction';
  if (/\bMED\s*[-–]\s*\d{4}/i.test(title)) return 'formal_notice';
  const text = clean(chunk);
  if (/#Sanction\b/.test(text)) return 'sanction';
  if (/#Mise en demeure/i.test(text)) return 'formal_notice';
  return null;
}

function refOf(title) {
  const m = title.match(/\b((?:SAN|MED)\s*[-–]\s*\d{4}\s*[-–]\s*\d{1,3})\b/i);
  return m ? m[1].replace(/\s*[-–]\s*/g, '-') : '';
}

function dateOf(title) {
  const m = title.match(/\b(\d{1,2}(?:er)?\s*[a-zéûè]+\s+\d{4})\b/i);
  return m ? m[1] : '';
}

const cc = (reason, excerpt, source_url) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  // The site's search wants every word to appear, so the legal form ("SAS", "S.A.R.L.") is left out of the query and of the match.
  const words = String(keyword || '').trim().split(/\s+/).filter((w) => w && !LEGAL.has(tokens(w).join('')));
  const query = words.join(' ');
  const firstUrl = searchUrl(query, 0);
  try {
    const kw = tokens(query);
    if (kw.length === 0) return cc('other', 'no company name left after removing the legal form', firstUrl);

    const records = [];
    const seen = new Set();
    let total = null;
    let pagesRead = 0;
    let complete = false;
    let blockedBy = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) break;
      const url = searchUrl(query, page);
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`, url);
      if (!res.ok) return cc('http_error', `HTTP ${res.status}`, url);

      const html = await res.text();
      const count = totalCount(html);
      if (count === null) {
        // Normal pages carry the words "recaptcha" in their settings, so only a page without results is checked.
        if (/captcha challenge|cf-chl|Just a moment|verify you are human/i.test(html)) return cc('blocked', 'bot or captcha check page', url);
        return cc('layout_changed', 'search result count not found on the page', url);
      }
      total = count;
      pagesRead++;

      const rows = parseRows(html);
      if (page === 0 && total > 0 && rows.length === 0) return cc('layout_changed', 'results counted but no result rows found', url);

      for (const r of rows) {
        const kind = classify(r.title, r.chunk);
        if (!kind) continue;
        if (!containsSeq(tokens(`${r.title} ${r.intro}`), kw)) continue;
        const key = `${r.href}|${r.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          name: r.title,
          reference: refOf(r.title),
          date: dateOf(r.title),
          kind,
          url: new URL(r.href, SEARCH).href,
          summary: r.intro.slice(0, 500),
        });
      }

      // The site shows 10 results per page. The "next" link stays on the last page, so the count decides when to stop.
      if (rows.length === 0 || (page + 1) * 10 >= total) { complete = true; break; }
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: firstUrl, excerpt: (records[0].summary || records[0].name).slice(0, 500) };
    }
    if (!complete) {
      const why = Date.now() - started > DEADLINE_MS ? 'timeout' : 'other';
      return cc(why, `no match in the first ${pagesRead} page(s) of ${total} results; the rest was not read`, firstUrl);
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: firstUrl,
      excerpt: `no CNIL sanction or formal notice names "${keyword}" (${total} search results read)`,
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return cc(reason, String(err?.message || err).slice(0, 300), firstUrl);
  }
}
