export const meta = {
  task: 'FR-annuaire.experts-comptables.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entity_type', 'address', 'profile_url'],
  canary: { found: 'DUPONT FINANCES', not_found: 'ZORGLUBBIA EXPERTISE COMPTABLE' },
};

const BASE = 'https://annuaire.experts-comptables.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 3;
const BUDGET_MS = 35000;

// The site's name search does not ignore legal forms ("DUPONT FINANCES SARL" gives 0 results),
// so trailing legal-form words are dropped before searching and before comparing names.
const LEGAL_WORDS = new Set(['SARL', 'SAS', 'SASU', 'SA', 'SELARL', 'SELAS', 'SELAFA', 'SELURL', 'SEL', 'SCP', 'SCM', 'SCI', 'SNC', 'SCOP', 'EURL', 'EI', 'SPFPL']);
const LEGAL_PHRASES = [
  ['SOCIETE', 'ANONYME'],
  ['SOCIETE', 'A', 'RESPONSABILITE', 'LIMITEE'],
  ['SOCIETE', 'PAR', 'ACTIONS', 'SIMPLIFIEE'],
  ['SOCIETE', 'CIVILE'],
  ['SOCIETE', 'EN', 'NOM', 'COLLECTIF'],
];

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/Œ/g, 'OE').replace(/Æ/g, 'AE');
}

/** Returns how many leading words are kept after dropping trailing legal-form words (at least one word is kept). */
function legalTail(keys) {
  let end = keys.length;
  for (;;) {
    if (end <= 1) break;
    const phrase = LEGAL_PHRASES.find(ph => end > ph.length && ph.every((w, i) => keys[end - ph.length + i] === w));
    if (phrase) { end -= phrase.length; continue; }
    if (LEGAL_WORDS.has(keys[end - 1])) { end -= 1; continue; }
    break;
  }
  return end;
}

/** Normalised name used to compare a typed name with a listed name. */
function matchKey(name) {
  const words = fold(name).replace(/[.'’`]/g, '').split(/[^A-Z0-9]+/).filter(Boolean);
  return words.slice(0, legalTail(words)).join(' ');
}

/** The name as typed, with trailing legal-form words removed, for the site's search box. */
function searchTerm(keyword) {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  const keys = words.map(w => fold(w).replace(/[^A-Z0-9]/g, ''));
  return words.slice(0, legalTail(keys)).join(' ');
}

function decode(s) {
  return String(s || '')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** One record per result card on a search page. */
function parseCards(html) {
  const cards = [];
  const seen = new Set();
  for (const chunk of html.split('<div class="profil-block d-flex firm"').slice(1)) {
    const href = (chunk.match(/<a href="(\/expert-comptable\/[^"]+)"/) || [])[1];
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const name = decode((chunk.match(/data-title="([^"]*)"/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    cards.push({
      name,
      entity_type: cleanText((chunk.match(/<span class="name-type">([\s\S]*?)<\/span>/) || [])[1]),
      address: cleanText((chunk.match(/<span class="address">([\s\S]*?)<\/span>/) || [])[1]),
      profile_url: new URL(href, BASE).href,
    });
  }
  return cards;
}

/** Highest result-page number linked from the pager (1 when there is no pager). */
function pagerMax(html) {
  const nums = [...html.matchAll(/href="\/recherche\/(\d+)\?/g)].map(m => +m[1]);
  return Math.max(1, ...nums);
}

function getPage(url) {
  return fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the keep-alive sockets of the last fetch close before the runner calls process.exit();
  // on Windows/Node 24 an immediate exit with an open socket aborts with an assertion (exit 127).
  await new Promise(resolve => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const typed = String(keyword || '');
  const term = searchTerm(typed);
  const key = matchKey(typed);
  const firstUrl = `${BASE}/recherche?comptable=${encodeURIComponent(term)}`;
  if (!term || !key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
  }
  try {
    let page = 1;
    for (;;) {
      const url = page === 1 ? firstUrl : `${BASE}/recherche/${page}?comptable=${encodeURIComponent(term)}`;
      const res = await getPage(url);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const noResults = html.includes('Aucun résultat');
      const hasResults = html.includes('Recherche des experts-comptables') || html.includes('profil-block');
      if (!noResults && !hasResults) {
        const botWall = /captcha|cf-chl|Access denied|Just a moment/i.test(html);
        return {
          status: 'couldnt_check', reason: botWall ? 'blocked' : 'layout_changed', records: [],
          source_url: url, excerpt: cleanText(html).slice(0, 300),
        };
      }

      const cards = parseCards(html);
      if (cards.length === 0) {
        if (noResults) {
          return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `Aucun résultat pour « ${term} »` };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }

      const matches = cards.filter(c => matchKey(c.name) === key);
      if (matches.length) {
        return {
          status: 'found', reason: '', records: matches, source_url: url,
          excerpt: cleanText(matches.map(m => `${m.name} ${m.entity_type} ${m.address}`).join(' | ')).slice(0, 300),
        };
      }

      const last = pagerMax(html);
      if (last <= page) {
        return {
          status: 'not_found', reason: '', records: [], source_url: firstUrl,
          excerpt: `${cards.length} result(s) on page ${page} for « ${term} », none with this name`,
        };
      }
      if (page >= MAX_PAGES || Date.now() - started > BUDGET_MS) {
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: url,
          excerpt: `no exact match on the first ${page} result page(s) of ${last}; the rest were not checked`,
        };
      }
      page += 1;
    }
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: firstUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
