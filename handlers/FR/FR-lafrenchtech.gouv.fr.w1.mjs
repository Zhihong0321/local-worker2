export const meta = {
  task: 'FR-lafrenchtech.gouv.fr',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website', 'programme'],
  canary: { found: 'Mistral AI', not_found: 'Entreprise Fantôme Inexistante SAS' },
};

// One plain HTML page that lists every French Tech Next40/120 laureate (all 120 are in the HTML; some sit in a
// hidden "Voir tous les lauréats" block, and they are read too).
const PAGE = 'https://lafrenchtech.gouv.fr/fr/programme/french-tech-next-40-120/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRAMME = 'French Tech Next40/120';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ocirc: 'ô',
  ucirc: 'û', uuml: 'ü', ouml: 'ö', euml: 'ë', iuml: 'ï',
};

// French legal forms. Removed only from the start or end of a name, so "Mistral AI SAS" matches "Mistral AI".
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'sarlu', 'eurl', 'sa', 'sca', 'snc', 'sci', 'selarl', 'selas', 'gie', 'scop']);

function decodeHtml(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(ENTITIES, n.toLowerCase()) ? ENTITIES[n.toLowerCase()] : m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparable form of a company name: no case, accents, punctuation, spaces or legal form. */
function normalizeName(raw) {
  let s = decodeHtml(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const tokens = s ? s.split(' ') : [];
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[0])) tokens.shift();
  return tokens.join('');
}

/** Every laureate card on the page: { name, website }. */
function parseLaureates(html) {
  const out = [];
  const cardRe = /<a\s[^>]*laureat-item[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const hrefMatch = openTag.match(/href="([^"]*)"/);
    const nameMatch = m[1].match(/class="nom-laureat[^"]*"[^>]*>([^<]*)</);
    const name = decodeHtml(nameMatch ? nameMatch[1] : '');
    if (name) out.push({ name, website: hrefMatch ? decodeHtml(hrefMatch[1]) : '' });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = normalizeName(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const laureates = parseLaureates(html);
    if (laureates.length === 0) {
      const text = decodeHtml(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')).slice(0, 300);
      const reason = /captcha|challenge-platform|cf-chl/i.test(html) ? 'blocked' : 'layout_changed';
      return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: text };
    }

    const matches = laureates.filter((l) => normalizeName(l.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `Checked ${laureates.length} laureate names on the ${PROGRAMME} page; none matches "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((l) => ({ name: l.name, website: l.website, programme: PROGRAMME })),
      source_url: PAGE,
      excerpt: `Listed on the ${PROGRAMME} laureates page: ${matches.map((l) => l.name).join(', ')}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
