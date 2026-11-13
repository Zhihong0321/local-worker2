export const meta = {
  task: 'FR-batiproduits.com',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'site_id', 'profile_url', 'description'],
  canary: { found: 'VILLEROY & BOCH', not_found: 'Zqxwvbnm Industrie SARL' },
};

const BASE = 'https://www.batiproduits.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms and connector words that are dropped before comparing names (compared without accents, lower case).
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'sci', 'snc', 'sca', 'scop', 'gmbh', 'ag', 'kg',
  'ltd', 'limited', 'llc', 'inc', 'srl', 'spa', 'bv', 'nv', 'plc', 'ets', 'ste', 'societe', 'cie', 'et', 'and']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  ndash: '-', mdash: '-', hellip: '...', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  auml: 'ä', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç', iuml: 'ï', icirc: 'î',
  oelig: 'œ', aelig: 'æ', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç',
};

function decodeHtml(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

function cleanText(html) {
  return decodeHtml(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Words of a name: split on any punctuation, spaces, '&' and '-'.
function words(s) {
  return String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// The comparison key of a company name: legal form and connector words removed, accents and punctuation removed.
function nameKey(s) {
  return words(s).map(fold).filter((w) => !LEGAL_FORMS.has(w)).join('');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = BASE;
  try {
    const queryWords = words(keyword).filter((w) => !LEGAL_FORMS.has(fold(w)));
    if (queryWords.length === 0) return fail('other', searchUrl, 'no company name left after removing punctuation and legal form');

    const key = nameKey(keyword);
    const params = new URLSearchParams({ p: '2', sp: '0', type: 'entreprise', search: queryWords.join(' ') });
    searchUrl = `${BASE}?${params.toString()}`;

    const res = await fetch(searchUrl, {
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const answered = html.includes('class="resultatsRecherche"');
    if (!answered) {
      if (/captcha|challenge-platform|cf-chl|Attention Required|Access denied/i.test(html)) {
        return fail('blocked', searchUrl, 'bot check page instead of search results');
      }
      return fail('layout_changed', searchUrl, cleanText(html).slice(0, 300));
    }

    // Manufacturer cards: <a href="/fiche/fabricant/<slug>-<id>/" class="lienPx"> ... <h2 class="titrePxGene">NAME</h2>
    const cards = [];
    const cardRe = /<a href="(\/fiche\/fabricant\/[^"]+)" class="lienPx">([\s\S]*?)<\/a>/g;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const h2 = m[2].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      if (!h2) continue;
      const desc = m[2].match(/<p[^>]*descProdCat[^>]*>([\s\S]*?)<\/p>/i);
      const profileUrl = new URL(m[1], BASE).href;
      const idMatch = profileUrl.match(/-(\d+)\/?$/);
      cards.push({
        name: cleanText(h2[1]),
        site_id: idMatch ? idMatch[1] : '',
        profile_url: profileUrl,
        description: desc ? cleanText(desc[1]).slice(0, 300) : '',
      });
    }

    if (cards.length === 0) {
      if (/titrePxGene|fiche\/fabricant\//.test(html)) {
        return fail('layout_changed', searchUrl, 'manufacturer cards found in an unexpected form');
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Batiproduits returned 0 manufacturers for "${keyword}"`,
      };
    }

    const matches = cards.filter((c) => nameKey(c.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Batiproduits returned ${cards.length} manufacturer(s) for "${keyword}", none with this name: ` +
          cards.slice(0, 5).map((c) => c.name).join('; '),
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((c) => ({ name: c.name, site_id: c.site_id, profile_url: c.profile_url, description: c.description })),
      source_url: matches[0].profile_url,
      excerpt: `${matches[0].name}: ${matches[0].description}`.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', searchUrl, String((err && err.message) || err));
  }
}
