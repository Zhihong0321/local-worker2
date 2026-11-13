export const meta = {
  task: 'ID-kontan.co.id',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['title', 'published', 'section', 'url'],
  canary: { found: 'Garuda Indonesia', not_found: 'PT Khayalan Nusantara Abadi' },
};

const BASE = 'https://www.kontan.co.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pt', 'tbk', 'persero', 'cv', 'ud', 'perum']);

/** Lower-case word tokens, accents removed, punctuation dropped. */
function tokens(str) {
  return (str || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

/** Name tokens without the legal form (PT, Tbk, Persero, CV ...). */
function coreTokens(name) {
  return tokens(name).filter((t) => !LEGAL_FORMS.has(t));
}

/**
 * The text sent to the site's search: the name without legal-form words and brackets.
 * The site answers some legal-form shapes (e.g. "PT ... (Persero) Tbk") with a soft "page not found",
 * while the bare name searches normally.
 */
function searchTerm(keyword) {
  return String(keyword || '')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w.toLowerCase().replace(/\./g, '')))
    .join(' ');
}

/** True when the needle tokens appear as one contiguous run inside the haystack tokens. */
function containsRun(hay, needle) {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Article rows of the search results list (the first page only). */
function parseItems(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  const start = body.indexOf('class="list-berita"');
  if (start < 0) return [];
  const end = body.indexOf('<nav', start);
  const block = body.slice(start, end > start ? end : undefined);
  const items = [];
  for (const part of block.split(/<li>/i).slice(1)) {
    const h1 = part.match(/<h1>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h1>/i);
    if (!h1) continue;
    const date = part.match(/<span class="font-gray">([\s\S]*?)<\/span>/i);
    const section = part.match(/<span class="linkto-orange[^"]*">\s*<a[^>]*>([^<]*)<\/a>/i);
    items.push({
      title: decode(h1[2]),
      url: new URL(decode(h1[1]), BASE).href,
      published: date ? decode(date[1]).replace(/^\|\s*/, '') : '',
      section: section ? decode(section[1]) : '',
    });
  }
  return items;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Let the HTTP socket finish closing before the caller exits the process (process.exit right after a
  // fetch crashes libuv on Windows, exit code 127). 200 ms is enough.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return answer;
}

async function search(keyword) {
  const term = searchTerm(keyword);
  const searchUrl = `${BASE}/search/?search=${encodeURIComponent(term)}`;
  try {
    const needle = coreTokens(keyword);
    if (needle.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'no usable name in the keyword' };
    }

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/<title>[^<]*(Just a moment|Attention Required)/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
    }

    // The site's own "no articles" message.
    if (/class="maaf"|Maaf Berita yang anda cari tidak ada/i.test(html)) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'Maaf Berita yang anda cari tidak ada (no articles for this search)' };
    }

    const items = parseItems(html);
    if (items.length === 0) {
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: `no result list on the page; title: ${title}`.slice(0, 300) };
    }

    // Keep only articles whose headline names the company (legal form ignored, whole words, same order).
    const matches = items.filter((it) => containsRun(tokens(it.title), needle));
    if (matches.length === 0) {
      // Articles came back, but none names the company in its headline. The page shows no body text,
      // so this cannot be called not_found.
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: searchUrl,
        excerpt: `search returned ${items.length} articles on page 1, none with the company name in the headline`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: searchUrl,
      excerpt: `${matches.length} of ${items.length} articles on page 1 name the company: ${matches[0].title}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
