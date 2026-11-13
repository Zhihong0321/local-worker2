export const meta = { task: 'FR-fbf.fr', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'cib'],
  canary: { found: 'Bforbank', not_found: 'Banque Zorvelle Imaginaire' } };

// FBF's own pages do not publish a member roster (fbf.fr/fr/la-federation/adherents/ says "Liste en cours de mise a jour").
// The one public company list the FBF runs is the list of member banks of its mediation service, on its subdomain.
const LIST_URL = 'https://lemediateur.fbf.fr/Banques+adherentes';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Trailing legal-form words, removed before comparing so "ACME SA" and "ACME" are the same company.
const LEGAL = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'snc', 'sci', 'sca', 'scs', 'ltd', 'plc', 'ag', 'gmbh',
  'bv', 'nv', 'spa', 'srl', 'llc', 'inc', 'sdn', 'bhd', 'societe', 'anonyme']);

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä', ocirc: 'ô', ouml: 'ö',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü', icirc: 'î', iuml: 'ï', ccedil: 'ç', oelig: 'œ', ndash: '–', mdash: '—' };

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparison key: accents, case, punctuation and trailing legal form removed; words joined. */
function normName(str) {
  const t = (str || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = t ? t.split(' ') : [];
  while (toks.length && LEGAL.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

function parseRows(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
    if (cells.length >= 2) rows.push({ name: cells[0], cib: cells[1] });
  }
  return rows;
}

function failure(reason, excerpt, status) {
  return { status: status ?? 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normName(keyword);
    if (!key) return failure('other', 'the name has no letters to compare');

    const res = await fetch(LIST_URL, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5'
      },
      signal: AbortSignal.timeout(25000)
    });

    if (res.status === 403 || res.status === 429) return failure('blocked', `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|cf-chl|cf-browser-verification/i.test(html)) return failure('blocked', 'bot check page');

    if (!html.includes('Etablissement bancaire') || !/<table/i.test(html)) {
      return failure('layout_changed', html.slice(0, 300));
    }
    const rows = parseRows(html);
    if (rows.length === 0) return failure('layout_changed', 'member table has no rows');

    const matches = rows.filter(r => normName(r.name) !== '' && normName(r.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `"${keyword}" is not in the list of ${rows.length} member banks`
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map(m => ({ name: m.name, cib: m.cib })),
      source_url: LIST_URL,
      excerpt: 'Banques adherentes: ' + matches.map(m => `${m.name} (CIB ${m.cib || 'not given'})`).join('; ')
    };
  } catch (err) {
    const timed = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return failure(timed ? 'timeout' : 'other', err?.message || err);
  }
}
