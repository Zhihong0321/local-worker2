export const meta = {
  task: 'VN-canchamvietnam.org',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listing_url', 'listing_id', 'categories', 'description'],
  canary: { found: '3rd Floor Meats', not_found: 'Công ty TNHH Dezeno Việt Nam' },
};

// CanCham Vietnam keeps its member directory as WordPress "listing" posts. The public WordPress REST
// endpoint searches them (?search=) and returns a JSON array; no login, token or captcha is involved.
const API = 'https://canchamvietnam.org/wp-json/wp/v2/listing';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;

// Legal-form words (folded: no accents, lower case). Stripped only at the start or end of a name, so a
// word inside a real name ("Thanh Trading") is kept.
const LEGAL = new Set([
  'co', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'llc', 'llp', 'plc', 'pte', 'pvt',
  'private', 'gmbh', 'sdn', 'bhd', 'berhad', 'company', 'jsc', 'sa', 'sas', 'sarl', 'bv', 'nv',
  'tnhh', 'cp', 'cong', 'ty', 'phan', 'trach', 'nhiem', 'huu', 'han', 'mot', 'thanh', 'vien',
  'chi', 'nhanh', 'doanh', 'nghiep', 'tu', 'nhan',
]);

function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

function wordsOf(s) {
  return fold(s).match(/[\p{L}\p{N}]+/gu) || [];
}

/** Words of a company name without its legal form at the start or end. */
function coreWords(s) {
  const t = wordsOf(s);
  let a = 0;
  let b = t.length;
  while (a < b && LEGAL.has(t[a])) a++;
  while (b > a && LEGAL.has(t[b - 1])) b--;
  return b > a ? t.slice(a, b) : t;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function plainText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The whole title, the title without a bracketed short name, and the bracketed part on its own. */
function nameCandidates(title) {
  const noBrackets = title.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const inBrackets = [...title.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  return [title, noBrackets, ...inBrackets].filter(Boolean);
}

function toRecord(item) {
  const name = plainText(item.title && item.title.rendered);
  const categories = (item.class_list || [])
    .filter((c) => c.startsWith('listing_category-'))
    .map((c) => c.slice('listing_category-'.length));
  return {
    name,
    listing_url: item.link || '',
    listing_id: item.id,
    categories,
    description: plainText(item.content && item.content.rendered).slice(0, 300),
  };
}

function blockedText(text) {
  return /captcha|challenge|access denied|attention required|cloudflare/i.test(text);
}

/** Every listing the search returns for one word. Returns { items, url } or { failure }. */
async function searchWord(word) {
  const items = [];
  let firstUrl = '';
  let page = 1;
  let totalPages = 1;
  do {
    const url = `${API}?search=${encodeURIComponent(word)}&per_page=100&page=${page}&_fields=id,link,title,content,class_list`;
    if (!firstUrl) firstUrl = url;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { failure: { status: 'couldnt_check', reason: 'blocked', source_url: url, excerpt: `HTTP ${res.status}` } };
    }
    if (!res.ok) {
      return { failure: { status: 'couldnt_check', reason: 'http_error', source_url: url, excerpt: `HTTP ${res.status}` } };
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!Array.isArray(data)) {
      const reason = blockedText(text) ? 'blocked' : 'layout_changed';
      return { failure: { status: 'couldnt_check', reason, source_url: url, excerpt: text.slice(0, 200) } };
    }
    items.push(...data);
    totalPages = parseInt(res.headers.get('x-wp-totalpages') || '1', 10) || 1;
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);
  return { items, url: firstUrl };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Give the finished request's socket time to close before the caller exits. On Windows with Node 24 a
  // process that exits while a keep-alive socket is still closing aborts with code 127. The answer is unchanged.
  await new Promise((r) => setTimeout(r, 150));
  return answer;
}

async function run(keyword) {
  try {
    const words = coreWords(keyword);
    const key = words.join('');
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'no name in the input' };
    }

    // The site search matches whole words, so search with the longest word of the name and compare
    // every hit in code. That avoids missing a company because of a legal form or a punctuation mark.
    const term = words.reduce((best, w) => (w.length > best.length ? w : best), '');
    const searched = await searchWord(term);
    if (searched.failure) {
      return { ...searched.failure, records: [], excerpt: searched.failure.excerpt };
    }

    const matches = searched.items.filter((item) => {
      const title = plainText(item.title && item.title.rendered);
      return nameCandidates(title).some((c) => {
        const ck = coreWords(c).join('');
        return ck && ck === key;
      });
    });

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searched.url,
        excerpt: `0 directory listings match "${keyword}" (search "${term}" returned ${searched.items.length} listings)`,
      };
    }

    const records = matches.map(toRecord);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].listing_url || searched.url,
      excerpt: `${records[0].name}: ${records[0].description}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: API,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
