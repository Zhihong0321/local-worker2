export const meta = { task: 'ES-ceoe.es', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'list', 'member_list_url'],
  canary: { found: 'ACCIONA', not_found: 'Compañía Inventada Ficticia S.L.' } };

// CEOE publishes its member companies as a logo grid: each logo is an image whose alt text is the company name.
const LIST_URL = 'https://www.ceoe.es/es/asociados/miembros-actuales/empresas-asociadas';
const LIST_NAME = 'Empresas asociadas (CEOE member companies)';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, removed from the end of a name before comparing.
const LEGAL = new Set(['sa', 'sl', 'slu', 'sau', 'sas', 'ltd', 'limited', 'plc', 'inc', 'gmbh',
  'sociedad', 'anonima', 'limitada', 'unipersonal', 's', 'l', 'u', 'a']);

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The name as the logo shows it: "Logo de X", "X Logo", "X - Logo", "x.png", and a trailing year are removed. */
function displayName(alt) {
  return decode(alt)
    .replace(/\.(png|jpe?g|gif|svg|webp)$/i, '')
    .replace(/^logo de\s+/i, '')
    .replace(/\s*[-–]?\s*logo\s*$/i, '')
    .replace(/\s+(19|20)\d{2}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised comparison key: no accents, case or punctuation, and no trailing legal form. */
function key(s) {
  const tokens = decode(String(s))
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: excerpt.slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = key(keyword || '');
    if (!kw) return couldnt('other', 'empty company name');

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (!/Empresas asociadas/i.test(html)) {
      const bot = /cf-chl|g-recaptcha|h-captcha|captcha-delivery|attention required|just a moment/i.test(html);
      return bot ? couldnt('blocked', 'bot check page instead of the member list') : couldnt('layout_changed', 'member list heading not found');
    }

    const names = [];
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/src="[^"]*\/sites\/ceoe-corporativo\/files\//i.test(tag)) continue;
      const alt = (tag.match(/\salt="([^"]*)"/i) || [])[1] || '';
      const name = displayName(alt);
      if (name) names.push(name);
    }
    if (names.length === 0) return couldnt('layout_changed', 'no member logos found on the list page');

    const records = [];
    const seen = new Set();
    for (const n of names) {
      if (key(n) !== kw || seen.has(n)) continue;
      seen.add(n);
      records.push({ name: n, list: LIST_NAME, member_list_url: LIST_URL });
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: LIST_URL,
        excerpt: `Listed on the CEOE member-company list as "${records[0].name}" (${names.length} companies on the list)` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: LIST_URL,
      excerpt: `No match for "${keyword}" among ${names.length} companies on the CEOE member-company list` };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
