export const meta = {
  task: 'FR-ansm.sante.fr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['title', 'published', 'categories', 'url', 'excerpt'],
  canary: { found: 'Sanofi Winthrop Industrie', not_found: 'Laboratoire Zxqwvk Inexistant' },
};

const BASE = 'https://ansm.sante.fr';
const SEARCH = `${BASE}/resultats-de-recherche`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...' };

/** Decode the HTML entities the site uses (numeric and common named ones) before comparing text. */
function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m))
    .replace(/&[a-z]+;/gi, (m) => {
      // accented letters, e.g. &eacute; -> e (accents are removed by normalise anyway)
      const base = m.slice(1, -1).replace(/(acute|grave|circ|uml|cedil|tilde|ring|slash)$/i, '');
      return base && base.length === 1 ? base : ' ';
    });
}

function cleanText(s) {
  return decodeEntities((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare form: no case, no accents, no punctuation, single spaces. */
function normalise(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const LEGAL_TAIL = /(?:^|[\s,])(?:s\.?\s?a\.?\s?s\.?\s?u?|s\.?\s?a\.?\s?r\.?\s?l\.?|e\.?\s?u\.?\s?r\.?\s?l\.?|s\.?\s?c\.?\s?i\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?|gmbh|ltd|llc|inc|bv|nv|srl|spa|plc|sdn\s+bhd|bhd|ag)\.?\s*$/i;

/** Drop a trailing legal form ("SAS", "S.A.", "GmbH", ...) from the typed name; keep at least one word. */
function nameWithoutLegalForm(keyword) {
  let s = (keyword || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const m = s.match(LEGAL_TAIL);
    if (!m) break;
    const rest = s.slice(0, m.index).trim();
    if (!rest) break;
    s = rest;
  }
  return s;
}

function stripTags(s) {
  return cleanText(s);
}

/** Parse the article list on one results page. */
function parseArticles(html) {
  const items = [];
  const blocks = html.match(/<article class="article-item"[\s\S]*?<\/article>/g) || [];
  for (const b of blocks) {
    const href = (b.match(/<a href="([^"]+)"/) || [])[1] || '';
    const date = ((b.match(/PUBLI\S*\s+LE\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1]) || '';
    const title = stripTags((b.match(/<span class="article-title[^"]*">([\s\S]*?)<\/span>/) || [])[1] || '');
    const cats = [...b.matchAll(/<span class="article-category[^"]*">([\s\S]*?)<\/span>/g)].map((m) => stripTags(m[1])).filter(Boolean);
    const content = stripTags((b.match(/<span class="article-content">([\s\S]*?)<\/span>/) || [])[1] || '');
    let url = '';
    try { url = new URL(decodeEntities(href), BASE).href; } catch (e) { url = ''; }
    items.push({ title, published: date, categories: cats.join(' > '), url, excerpt: content.slice(0, 300) });
  }
  return items;
}

async function getPage(keyword, page) {
  const u = new URL(SEARCH);
  u.searchParams.set('filter[text]', keyword);
  u.searchParams.set('filter[matching]', 's'); // "phrase exacte"
  if (page > 1) u.searchParams.set('page', String(page));
  const res = await fetch(u.href, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
  return { res, url: u.href };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let sourceUrl = SEARCH;
  try {
    const name = nameWithoutLegalForm(keyword);
    const core = normalise(name);
    if (core.replace(/ /g, '').length < 3) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH, excerpt: 'name too short for the site search (minimum 3 characters)' };
    }

    const all = [];
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > 40000) break; // stay well inside the 60 s limit
      const { res, url } = await getPage(name, page);
      if (page === 1) sourceUrl = url;

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const finalUrl = res.url || url;
      if (!finalUrl.startsWith(BASE + '/')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: `redirected to ${finalUrl}`.slice(0, 300) };
      }

      const html = await res.text();
      if (/captcha|cf-chl|just a moment|access denied/i.test(html) && !/resultats-de-recherche|article-item/.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check or captcha page' };
      }
      const countMatch = html.match(/<strong>\s*([\d\s]+?)\s*<\/strong>\s*R[ée]sultats?\s+pour\s+votre\s+recherche/i);
      if (!countMatch && !html.includes('search-result-list')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }
      const pageTotal = countMatch ? parseInt(countMatch[1].replace(/\s/g, ''), 10) : 0;
      if (total === null) total = pageTotal;

      const items = parseArticles(html);
      all.push(...items);
      if (items.length === 0 || page * 50 >= total) break;
    }

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl, excerpt: `0 results for the exact name "${name}"` };
    }

    const records = [];
    const seen = new Set();
    const padded = (s) => ` ${normalise(decodeEntities(s))} `;
    for (const it of all) {
      if (!it.url || seen.has(it.url)) continue;
      const hay = padded(`${it.title} ${it.excerpt}`);
      if (hay.includes(` ${core} `)) {
        seen.add(it.url);
        records.push({ title: it.title, published: it.published, categories: it.categories, url: it.url, excerpt: it.excerpt });
      }
    }

    if (records.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: sourceUrl,
        excerpt: `the site returned ${total} hits for "${name}" but none shows the name in its title or summary (${all.length} read)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: `${records.length} result(s) name "${name}" in the title or summary (${total} hits for the exact name, ${all.length} read)`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
