export const meta = {
  task: 'IE-hospitalityireland.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['title', 'category', 'url', 'name_in_title'],
  canary: { found: 'Travail Hospitality', not_found: 'Cuideachta Ghealach Mhara Teoranta' },
};

const BASE = 'https://www.hospitalityireland.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words. The site search returns "No results" when they are included, so they are dropped before searching.
const LEGAL_FORMS = new Set(['ltd', 'limited', 'dac', 'designated', 'activity', 'company', 'co', 'plc', 'unlimited', 'uc',
  'teoranta', 'teo', 'inc', 'llc', 'gmbh', 'sdn', 'bhd']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
  ndash: '-', mdash: '-', hellip: '...', euro: '€', pound: '£' };
const COMBINING = { acute: '́', grave: '̀', uml: '̈', circ: '̂', tilde: '̃', cedil: '̧', ring: '̊' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      if (NAMED[name] !== undefined) return NAMED[name];
      const acc = name.match(/^([A-Za-z])(acute|grave|uml|circ|tilde|cedil|ring)$/);
      if (acc) return (acc[1] + COMBINING[acc[2]]).normalize('NFC');
      return m;
    });
}

/** Lower case, no accents, no punctuation: "Dílis Hospitality, Ltd." -> "dilis hospitality ltd". */
function norm(s) {
  return decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The company words without trailing legal-form words. */
function coreWords(keyword) {
  const words = norm(keyword).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words;
}

function titleHasName(title, core) {
  return (' ' + norm(title) + ' ').includes(' ' + core.join(' ') + ' ');
}

/** One record per search result card: headline, category, article URL, and whether the name is in the headline. */
function parseCards(html, core) {
  const out = [];
  for (const block of html.split('<article').slice(1)) {
    const body = block.split('</article>')[0];
    const h = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const link = body.match(/<a href="([^"]+)"/i);
    if (!h || !link) continue;
    const cat = body.match(/<a class="text-red-600[^"]*"[^>]*title="([^"]*)"/i);
    const title = decode(h[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    out.push({
      title,
      category: cat ? decode(cat[1]).trim() : '',
      url: new URL(decode(link[1]), BASE).href,
      name_in_title: titleHasName(title, core),
    });
  }
  return out;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = `${BASE}/search/`;
  try {
    const core = coreWords(String(keyword || ''));
    if (core.length === 0) return couldnt('other', searchUrl, 'empty company name');

    searchUrl = `${BASE}/search/?q=${encodeURIComponent(core.join(' '))}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (/cf-chl|Just a moment|captcha/i.test(html.slice(0, 20000))) return couldnt('blocked', searchUrl, 'bot check page');

    const noResults = html.match(/No results found for[^<]*/i);
    if (noResults) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: decode(noResults[0]).trim() };
    }
    const header = html.match(/Search results from:[^<]*/i);
    if (!header) return couldnt('layout_changed', searchUrl, 'no search result heading on the page');

    const cards = parseCards(html, core);
    if (cards.length === 0) return couldnt('layout_changed', searchUrl, decode(header[0]).trim());

    const matched = cards.filter((c) => c.name_in_title);
    if (matched.length === 0) {
      // The site found articles, but none names the company in its headline. Not decided here: the hub reads it.
      return couldnt('other', searchUrl, `search returned ${cards.length} article(s), none with the name in its headline`);
    }

    return {
      status: 'found',
      reason: '',
      records: cards,
      source_url: searchUrl,
      excerpt: matched.slice(0, 3).map((c) => c.title).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, searchUrl, String(err?.message || err));
  }
}
