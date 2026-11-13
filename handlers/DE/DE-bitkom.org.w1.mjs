export const meta = { task: 'DE-bitkom.org', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'membership_tags'],
  canary: { found: 'A-Leecon GmbH', not_found: 'Bäckerei Zwiebelmuster Nordlicht GmbH' } };

// Bitkom's public member list (Drupal page). It is split into 27 letter pages (A-Z, then 0-9) with no search box and
// no pager. Each letter page lists its members as <div class="company-teaser__headline">NAME</div>.
const BASE = 'https://www.bitkom.org/Bitkom/Mitgliedschaft/Mitgliederliste';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'kg', 'co', 'ug', 'se', 'ohg', 'gbr', 'ev', 'eg', 'kgaa', 'bv', 'ltd', 'limited',
  'inc', 'llc', 'plc', 'sarl', 'sa', 'spa', 'srl', 'nv', 'ab', 'oy', 'sl', 'lp', 'llp']);

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#039;|&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

// Compare names: case, accents, punctuation and a trailing legal form (GmbH, AG, GmbH & Co. KG, e.V., B.V. ...) are ignored.
function normalize(str) {
  let s = decodeEntities(String(str || '')).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/\be\.\s*v\./g, 'ev').replace(/\bb\.\s*v\./g, 'bv').replace(/\./g, '').replace(/&/g, ' ');
  const tokens = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function stripTags(s) {
  return decodeEntities((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseTeasers(html) {
  const out = [];
  const parts = html.split('company-teaser contextual-region');
  for (let i = 1; i < parts.length; i++) {
    const head = parts[i].match(/company-teaser__headline">([\s\S]*?)<\/div>/);
    if (!head) continue;
    const name = stripTags(head[1]);
    if (!name) continue;
    const tags = [...parts[i].matchAll(/<div class="company-teaser__tag">([\s\S]*?)<\/div>/g)].map((m) => stripTags(m[1])).filter(Boolean);
    out.push({ name, membership_tags: tags });
  }
  return out;
}

function letterUrl(n) {
  return `${BASE}?letter=${n}`;
}

async function getLetter(n) {
  const url = letterUrl(n);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timed = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { error: timed ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200), url };
  }
  if (res.status === 403 || res.status === 429) return { error: 'blocked', excerpt: `HTTP ${res.status}`, url };
  if (!res.ok) return { error: 'http_error', excerpt: `HTTP ${res.status}`, url };
  const html = await res.text();
  if (/captcha|cf-chl|challenge-platform|access denied/i.test(html)) return { error: 'blocked', excerpt: 'bot check page', url };
  const teasers = parseTeasers(html);
  if (teasers.length === 0) return { error: 'layout_changed', excerpt: html.slice(0, 300).replace(/\s+/g, ' '), url };
  return { url, teasers };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalize(keyword);
    if (!kw) return couldnt('other', BASE, 'no company name in the keyword');

    // The letter page is chosen by the first character of the name. A name that does not start with A-Z or 0-9 is
    // checked against all 27 pages, so the answer never depends on the letter mapping.
    const c = kw[0];
    let letters;
    if (/[a-z]/.test(c)) letters = [c.charCodeAt(0) - 96];
    else if (/[0-9]/.test(c)) letters = [27];
    else letters = Array.from({ length: 27 }, (_, i) => i + 1);

    const pages = await Promise.all(letters.map((n) => getLetter(n)));
    const bad = pages.find((p) => p.error);
    if (bad) return couldnt(bad.error, bad.url, bad.excerpt);

    const listed = pages.flatMap((p) => p.teasers);
    const matches = listed.filter((t) => normalize(t.name) === kw);
    const source_url = letters.length === 1 ? letterUrl(letters[0]) : BASE;
    const label = letters.length === 1 ? (letters[0] === 27 ? '0-9' : String.fromCharCode(64 + letters[0])) : 'all letters';

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url,
        excerpt: `No match for "${keyword}" among ${listed.length} members listed on the Bitkom member list (${label})`,
      };
    }

    return {
      status: 'found', reason: '',
      records: matches.map((m) => ({ name: m.name, membership_tags: m.membership_tags })),
      source_url,
      excerpt: matches.map((m) => m.name + (m.membership_tags.length ? ` (${m.membership_tags.join(', ')})` : '')).join(' | ').slice(0, 500),
    };
  } catch (err) {
    return couldnt('other', BASE, String(err?.message || err).slice(0, 300));
  }
}
