export const meta = {
  task: 'FR-autoritedelaconcurrence.fr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['company', 'decision_id', 'title', 'decision_type', 'date', 'sector', 'url'],
  canary: { found: 'Engie', not_found: 'Dézénaux Fictive SARL' },
};

const BASE = 'https://www.autoritedelaconcurrence.fr';
const LIST_PATH = '/fr/liste-des-decisions-et-avis';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5; // the site shows 20 results per page
const DEADLINE_MS = 40000; // stop paging well before the 60 s limit
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'snc', 'sci', 'scop', 'gie', 'anonyme', 'gmbh', 'ag', 'ltd', 'limited', 'llc', 'inc', 'corp', 'co', 'plc', 'bv', 'nv', 'srl', 'spa', 'sdn', 'bhd', 'pte', 'pty', 'kk', 'lp', 'llp']);

/** A stop that is not a found/not_found answer. */
class Stop extends Error {
  constructor(reason, excerpt) {
    super(reason);
    this.reason = reason;
    this.excerpt = excerpt || '';
  }
}

/** Lower-case, no accents, no punctuation, single spaces: used for every name comparison. */
function normalize(str) {
  return (str || '')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLegalWord(word) {
  const toks = normalize(word).split(' ').filter(Boolean);
  return toks.length > 0 && toks.every((t) => LEGAL_FORMS.has(t));
}

/** The keyword without its legal form, as typed (accents kept) - used as the site search. */
function searchQuery(keyword) {
  return String(keyword || '').trim().split(/\s+/).filter((w) => w && !isLegalWord(w)).join(' ');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** One object per result row on the page. */
function parseRows(html) {
  const out = [];
  // Avis rows are "notice search-index clearfix", decision rows "decision search-index clearfix".
  for (const part of html.split(/(?:notice|decision) search-index clearfix/).slice(1)) {
    const h2 = part.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const text = stripTags(h2[1]);
    const idMatch = text.match(/^(\d{2}-[A-Za-z]+-\d+)\s*/);
    const title = idMatch ? text.slice(idMatch[0].length).trim() : text;
    if (!title) continue;
    const href = h2[1].match(/href="([^"]+)"/);
    const footer = part.match(/<div class="search-index__footer"[^>]*>([\s\S]*?)<\/div>/);
    const typeP = footer ? footer[1].match(/<p[^>]*>([\s\S]*?)<\/p>/) : null;
    const time = part.match(/<time[^>]*>([\s\S]*?)<\/time>/);
    const sector = part.match(/field--name-field-sector[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      decision_id: idMatch ? idMatch[1] : '',
      title,
      decision_type: typeP ? stripTags(typeP[1]) : '',
      date: time ? stripTags(time[1]) : '',
      sector: sector ? stripTags(sector[1]) : '',
      url: href ? new URL(href[1], BASE).href : '',
    });
  }
  return out;
}

async function fetchHtml(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Stop(timedOut ? 'timeout' : 'other', String(e?.message || e).slice(0, 300));
  }
  if (res.status === 403 || res.status === 429) throw new Stop('blocked', `HTTP ${res.status}`);
  if (!res.ok) throw new Stop('http_error', `HTTP ${res.status}`);
  let html;
  try {
    html = await res.text();
  } catch (e) {
    throw new Stop('timeout', String(e?.message || e).slice(0, 300));
  }
  const hasResults = html.includes('view-search') || html.includes('Aucun résultat ne correspond');
  if (!hasResults && /challenge-platform|cf-chl|Just a moment|captcha/i.test(html)) {
    throw new Stop('blocked', 'bot check page instead of search results');
  }
  return html;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const query = searchQuery(keyword);
  const core = normalize(query);
  const base = `${BASE}${LIST_PATH}?search_api_fulltext=${encodeURIComponent(query)}`;
  if (!core) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: base, excerpt: 'no company name left after removing the legal form' };
  }

  try {
    const rows = [];
    let complete = false;
    let stop = null;
    let empty = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > DEADLINE_MS) {
        stop = new Stop('timeout', `stopped after ${page} page(s): time limit`);
        break;
      }
      let html;
      try {
        html = await fetchHtml(page === 0 ? base : `${base}&page=${page}`);
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        stop = e;
        break;
      }
      if (html.includes('Aucun résultat ne correspond')) {
        empty = true;
        complete = true;
        break;
      }
      const pageRows = parseRows(html);
      if (!html.includes('view-search') || pageRows.length === 0) {
        stop = new Stop('layout_changed', stripTags(html).slice(0, 300));
        break;
      }
      rows.push(...pageRows);
      if (!/pager__item--next/.test(html)) {
        complete = true;
        break;
      }
    }

    // A decision names the company in its title: that is the match. Mentions only in the body text do not count.
    const matches = rows.filter((r) => ` ${normalize(r.title)} `.includes(` ${core} `));

    if (matches.length > 0) {
      const partial = stop ? ` (partial: ${stop.reason} after the pages read)` : '';
      return {
        status: 'found',
        reason: '',
        records: matches.map((m) => ({ company: query, ...m })),
        source_url: base,
        excerpt: (`${matches.length} decision(s) name "${query}" in the title${partial}: ` + matches.map((m) => `${m.decision_id} ${m.title}`).join(' | ')).slice(0, 500),
      };
    }
    if (stop) {
      return { status: 'couldnt_check', reason: stop.reason, records: [], source_url: base, excerpt: stop.excerpt };
    }
    if (empty) {
      return { status: 'not_found', reason: '', records: [], source_url: base, excerpt: 'Aucun résultat ne correspond à votre recherche' };
    }
    if (!complete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: base, excerpt: `more than ${MAX_PAGES * 20} search results; only the first ${MAX_PAGES} pages were read` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: base,
      excerpt: `${rows.length} search result(s) mention "${query}" in the decision text, but none names it in its title`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: base,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
