export const meta = { task: 'CH-swissholdings.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'address', 'website'], canary: { found: 'ABB Ltd', not_found: 'Bäckerei Zum Goldenen Hirschen AG' } };

// SwissHoldings publishes its member companies on one server-rendered page: one "member-card" per company, with the
// legal name, postal address and website. There is no search on that page, so the handler reads the whole list and
// matches the keyword against it.
const LIST_URL = 'https://www.swissholdings.ch/ueber-uns/mitglieder';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ag', 'sa', 'sarl', 'gmbh', 'ltd', 'limited', 'inc', 'llc', 'plc', 'nv', 'bv', 'kg', 'se', 'sas']);
const LEADING_ARTICLES = new Set(['die', 'der', 'das', 'the', 'le', 'la', 'les']);

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: no case, accents, punctuation, text after a comma or in brackets, legal form or leading article. */
function core(name) {
  let s = String(name || '').split(',')[0];
  s = s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && LEADING_ARTICLES.has(words[0])) words.shift();
  return words.join(' ');
}

function parseMembers(html) {
  const out = [];
  for (const block of html.split('<div class="member-card').slice(1)) {
    const card = block.split('<p class="members-empty')[0];
    const nameM = card.match(/<div class="font-medium">([\s\S]*?)<\/div>/);
    if (!nameM) continue;
    const name = cleanText(nameM[1]);
    const address = [...card.matchAll(/<div>([^<]*)<\/div>/g)].map((m) => cleanText(m[1])).filter(Boolean).join(', ');
    const web = card.match(/<a href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (name) out.push({ name, address, website: web ? web[1] : '' });
  }
  return out;
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    const members = parseMembers(html);
    if (!html.includes('member-card') || members.length === 0) return couldnt('layout_changed', html.slice(0, 300));

    const want = core(keyword);
    if (!want) return couldnt('other', 'empty company name');

    const matches = members.filter((m) => core(m.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `${members.length} member companies listed; none matches "${keyword}"`,
      };
    }
    return {
      status: 'found', reason: '',
      records: matches.map((m) => ({ name: m.name, address: m.address, website: m.website })),
      source_url: LIST_URL,
      excerpt: `${matches[0].name} | ${matches[0].address} | ${matches[0].website}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
