export const meta = { task: 'CH-svv.ch', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'founded', 'website'],
  canary: { found: 'Zürich Versicherungs-Gesellschaft AG', not_found: 'Bäckerei Zwiebelstrudel GmbH' } };

// SVV member list: server-rendered HTML, one <h3> per member; the page itself says "rund 70 Mitgliedern".
const LIST_URL = 'https://www.svv.ch/de/mitglieder';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_MEMBERS = 30; // fewer than this = the list did not come through whole, so no "not_found" is claimed
const LEGAL = new Set(['ag', 'sa', 'se', 'ltd', 'limited', 'gmbh', 'genossenschaft', 'kg', 'sarl', 'sagl', 'inc', 'corp']);

function decode(s) {
  return String(s || '')
    .replace(/­/g, '') // soft hyphens the site puts inside some names
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Case, accents, punctuation and a trailing legal form are ignored: "Swiss Re" = "SWISS RE AG". */
function normalize(s) {
  const words = decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function parseMembers(html) {
  const out = [];
  const re = /<h3 class="text-base font-bold lg:text-xl mt-2"><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/h3>/g;
  let m;
  while ((m = re.exec(html))) {
    const card = html.slice(html.lastIndexOf('<li ', m.index), m.index); // only this member's card
    const years = [...card.matchAll(/text-7xl font-bold">(\d{4})</g)];
    const name = decode(m[2]);
    if (name) out.push({ name, founded: years.length ? years[years.length - 1][1] : '', website: m[1] });
  }
  return out;
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalize(keyword);
    if (!key) return couldnt('other', 'empty company name');

    const res = await fetch(LIST_URL, {
      // Connection: close and identity (uncompressed body): with keep-alive or a compressed body, Node 24 on Windows
      // sometimes exits with a libuv assertion (code 127) after the answer is printed. Both headers avoid it.
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5', 'Accept-Encoding': 'identity', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|cf-chl|Just a moment/i.test(html.slice(0, 5000))) return couldnt('blocked', 'bot check page');

    const members = parseMembers(html);
    if (members.length < MIN_MEMBERS) {
      return couldnt('layout_changed', `found ${members.length} member entries, expected about 70`);
    }

    // Exact match after normalising. The part before a comma ("Pax, Schweizerische ...", "... SE, München, Zweigniederlassung ...") also counts as the company name.
    const hits = members.filter(m => normalize(m.name) === key || normalize(m.name.split(',')[0]) === key);
    if (hits.length) {
      return {
        status: 'found', reason: '',
        records: hits.map(h => ({ name: h.name, founded: h.founded, website: h.website })),
        source_url: LIST_URL,
        excerpt: hits.map(h => h.name).join(' | ').slice(0, 500),
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: LIST_URL,
      excerpt: `${members.length} SVV members listed; none matches "${String(keyword).slice(0, 120)}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
