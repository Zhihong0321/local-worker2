export const meta = { task: 'CH-sgv-usam.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'location', 'email', 'website'],
  canary: { found: 'Aargauischer Gewerbeverband', not_found: 'Zürcher Phantasieverband Nichtexistent' } };

const SITE = 'https://www.sgv-usam.ch/de/ueber-den-sgv/mitglieder/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = ['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'kg', 'ltd', 'llc', 'inc', 'eg'];

/** Normalised key: lower case, no accents, no punctuation, no trailing legal form. */
function keyOf(s) {
  const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL.includes(t[t.length - 1])) t.pop();
  return t.join('');
}

function decode(html) {
  const named = { amp: '&', nbsp: ' ', quot: '"', lt: '<', gt: '>', apos: "'" };
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = SITE;
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty keyword' };

    // The member list has no legal forms, so search with the name minus any trailing legal form.
    const words = kw.split(/\s+/);
    while (words.length > 1 && LEGAL.includes(keyOf(words[words.length - 1]))) words.pop();
    const query = words.join(' ');
    const want = keyOf(kw);
    searchUrl = `${SITE}?search=${encodeURIComponent(query)}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|Just a moment/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
    }
    const startMatch = html.match(/class="memberlist[ "]/);
    const start = startMatch ? startMatch.index : -1;
    if (start < 0 || !html.includes('Verband / Organisation')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: decode(html).slice(0, 300) };
    }
    const area = html.slice(start, html.indexOf('</ul>', start) + 5);
    const items = area.match(/<li>\s*<div class="row">[\s\S]*?<\/li>/g) || [];

    const records = [];
    for (const item of items) {
      const cols = [...item.matchAll(/<div class="col-sm-\d+">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
      if (cols.length < 4) continue;
      const name = decode(cols[0]);
      if (!name || keyOf(name) !== want) continue;
      records.push({ name, location: decode(cols[1]), email: decode(cols[2]), website: decode(cols[3]) });
    }

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: records.map((r) => `${r.name} | ${r.location} | ${r.email} | ${r.website}`).join(' ; ').slice(0, 500),
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `The SGV member list shows ${items.length} organisation(s) for "${query}", none with this name`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
