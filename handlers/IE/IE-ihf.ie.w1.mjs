export const meta = {
  task: 'IE-ihf.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url'],
  canary: { found: 'Access Hospitality', not_found: 'Cuideachta Neamhliostaithe Teoranta' },
};

const DIRECTORY_URL = 'https://www.ihf.ie/suppliers/suppliers-directory?ctg=All';
const BASE_URL = 'https://www.ihf.ie';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, English and Irish. Dropped only at the start or end of a name.
const LEGAL_WORDS = new Set(['limited', 'ltd', 'teoranta', 'teo', 'dac', 'plc', 'unlimited', 'ulc', 'uc', 'cuideachta', 'company', 'co', 'inc', 'llc']);

/** Comparable key: case, accents (fadas), punctuation, spacing and legal form ignored. */
function nameKey(str) {
  const s = String(str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_WORDS.has(words[0])) words.shift();
  while (words.length > 1 && LEGAL_WORDS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Each supplier card in the directory: its name and its profile address. */
function parseCards(html) {
  const rows = [];
  for (const card of html.split('class="card-B"').slice(1)) {
    const link = card.match(/href="([^"]*\/suppliers\/profiles\/[^"]+)"/i);
    const strong = card.match(/<strong>([\s\S]*?)<\/strong>/i);
    if (!link || !strong) continue;
    const name = cleanText(strong[1]);
    if (!name) continue;
    rows.push({ name, profile_url: new URL(decodeEntities(link[1]), BASE_URL).href });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = nameKey(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'empty company name' };
    }

    let res;
    try {
      res = await fetch(DIRECTORY_URL, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IE,en;q=0.9',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: DIRECTORY_URL, excerpt: 'no answer within 25 s' };
      }
      throw err;
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|Just a moment/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: 'bot check page' };
    }

    const rows = parseCards(html);
    // The directory always lists suppliers; zero parsed cards means the page changed, not an empty list.
    if (rows.length === 0 || !html.includes('Suppliers Directory')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: html.slice(0, 300) };
    }

    const matches = rows.filter((r) => nameKey(r.name) === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: DIRECTORY_URL,
        excerpt: `Suppliers Directory lists ${rows.length} companies; none matches "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({ name: m.name, profile_url: m.profile_url })),
      source_url: DIRECTORY_URL,
      excerpt: `Suppliers Directory: ${matches.map((m) => m.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
