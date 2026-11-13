export const meta = {
  task: 'AR-uia.org.ar',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listed_on'],
  canary: { found: 'Cervecería y Maltería Quilmes', not_found: 'Compañía Inexistente de Prueba S.A.' },
};

const PAGE = 'https://www.uia.org.ar/socios';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADING = 'Nuestros socios';
const MIN_MEMBERS = 50;

// Legal-form words, removed from the END of a normalised name only.
const LEGAL = new Set(['sa', 'saic', 'srl', 'sas', 'sau', 'ltda', 'ltd', 'inc', 'llc', 'sociedad', 'anonima', 'limitada', 'responsabilidad']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

/** Normalised company name: no accents, no case, no punctuation, no trailing legal form. */
function norm(s) {
  const t = decodeEntities(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const toks = t.split(' ').filter(Boolean);
  while (toks.length > 0 && LEGAL.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

/** Member names as the page writes them: the alt text of each member logo in the "Nuestros socios" block. */
function listedMembers(html) {
  const start = html.indexOf(HEADING);
  if (start < 0) return null;
  const out = [];
  const seen = new Set();
  for (const m of html.slice(start).matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const altM = tag.match(/\salt="([^"]*)"/i);
    const srcM = tag.match(/\ssrc="([^"]*)"/i);
    if (!altM || !srcM) continue;
    const alt = decodeEntities(altM[1]).replace(/\s+/g, ' ').trim();
    const src = srcM[1];
    if (!alt || /\bicon$/i.test(alt) || alt === 'UIA - Socios' || alt === 'Decorative') continue;
    if (!/\/media\/images\//i.test(src) || /Banner_Socios|Hero_Background/i.test(src)) continue;
    const key = norm(alt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: alt, key });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = norm(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const members = listedMembers(html);
    if (!members || members.length < MIN_MEMBERS) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: PAGE,
        excerpt: `members block not as expected (${members ? members.length : 0} logos)`,
      };
    }

    const hits = members.filter((m) => m.key === want);
    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `"${keyword}" is not among the ${members.length} members listed under "${HEADING}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: hits.map((h) => ({ name: h.name, listed_on: PAGE })),
      source_url: PAGE,
      excerpt: `Listed as a UIA member on ${PAGE}: ${hits.map((h) => h.name).join('; ')}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
