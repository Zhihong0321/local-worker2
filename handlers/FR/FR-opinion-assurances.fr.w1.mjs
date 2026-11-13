export const meta = { task: 'FR-opinion-assurances.fr', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'category', 'profile_url', 'average_rating'],
  canary: { found: 'Allianz', not_found: 'Assurances Zorbelune SA' } };

// The site's public alphabetical directory of every insurer and mutuelle it lists (robots.txt allows it; no query string, no /api/).
const LIST_URL = 'https://www.opinion-assurances.fr/tous-les-assureurs.html';
const BASE = 'https://www.opinion-assurances.fr/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'se', 'sca', 'scop', 'sci', 'sam', 'ste', 'societe', 'anonyme']);
const ARTICLES = new Set(['le', 'la', 'les', 'l']);

/** Normalised form of a name: no accents, no case, no punctuation, no legal form, no leading article. */
function normalise(str) {
  const tokens = String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' et ').split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length && ARTICLES.has(tokens[0])) tokens.shift();
  return tokens.filter((t) => !LEGAL_FORMS.has(t)).join('');
}

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** One entry per card of the directory page: name, category, profile URL and the all-products average (out of 5). */
function parseDirectory(html) {
  const entries = [];
  const cards = html.split('class="oa_carrier_card');
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];
    const link = card.match(/<a class="d-block" href="\/((?:assureur|mutuelle)-[^"]+\.html)" title="([^"]*)"/);
    if (!link) continue;
    const avg = card.match(/data-average-ALL='([^']*)'/);
    const rating = avg ? Number(avg[1]) : NaN;
    entries.push({
      name: decodeEntities(link[2]).trim(),
      category: link[1].startsWith('mutuelle-') ? 'mutuelle' : 'assureur',
      profile_url: new URL('/' + link[1], BASE).href,
      average_rating: Number.isFinite(rating) && rating >= 0 ? rating : null,
    });
  }
  return entries;
}

function reasonFor(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword ?? '').trim();
  try {
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const entries = parseDirectory(html);
    if (entries.length < 100 || !/Tous les assureurs/i.test(html)) {
      // Too few entries or the wrong page: a bot wall, or the page moved. Never a not_found.
      const wall = /captcha|cf-chl|just a moment|access denied/i.test(html);
      return {
        status: 'couldnt_check',
        reason: wall ? 'blocked' : 'layout_changed',
        records: [],
        source_url: LIST_URL,
        excerpt: `${entries.length} directory entries parsed; ${html.slice(0, 200).replace(/\s+/g, ' ')}`,
      };
    }

    const want = normalise(name);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'name has no usable letters after normalising' };
    }
    const matches = entries.filter((e) => normalise(e.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No listed insurer or mutuelle matches "${name}" (${entries.length} names checked)`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: LIST_URL,
      excerpt: matches.map((m) => `${m.name}: average ${m.average_rating ?? 'no rating'} / 5`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: reasonFor(err),
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
