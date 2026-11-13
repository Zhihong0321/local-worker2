export const meta = { task: 'RU-dreamjob.ru', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'employer_id', 'rating', 'reviews', 'url'],
  canary: { found: 'Яндекс', not_found: 'Ромашка Зноктонь Нетакая' } };

const BASE = 'https://dreamjob.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'нко', 'ано', 'гуп', 'фгуп', 'муп', 'тоо', 'чуп', 'llc', 'ltd', 'jsc']);

/** Lower-case words of a name, ё→е, punctuation and quotes removed. */
function tokens(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Drop a legal form (ООО, АО, ...) from the start and the end of the word list. */
function stripLegal(words) {
  const w = [...words];
  while (w.length && LEGAL.has(w[0])) w.shift();
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

/** Comparison key: normalised name without legal form. */
function nameKey(s) {
  return stripLegal(tokens(s)).join('');
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** One entry per employer card on a search results page. */
function parseCards(html) {
  const out = new Map();
  const re = /<a[^>]*href="\/employers\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const body = m[2];
    if (!/class="industry-card__name(?:\s[^"]*)?"/.test(body)) continue;
    const name = decode((body.match(/class="industry-card__name(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    if (!name || out.has(id)) continue;
    const rating = decode((body.match(/sb-rating__value[^>]*>\s*([\d.,]+)/) || [])[1]);
    const reviews = decode((body.match(/class="industry-card__review-link[^"]*"[^>]*>([^<]*)</) || [])[1]);
    out.set(id, { employer_id: id, name, rating, reviews, url: `${BASE}/employers/${id}` });
  }
  return [...out.values()];
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await lookupOnce(keyword);
  // On Windows (Node 24) the runner can call process.exit while the fetch socket is still closing, which aborts
  // the process with a libuv assertion (exit 127) after the answer is printed. A short pause lets it close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}

async function lookupOnce(keyword) {
  const raw = String(keyword || '').trim();
  const wantKey = nameKey(raw);
  if (!wantKey) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no company name in the input' };
  }
  const searchTerm = stripLegal(tokens(raw)).join(' ');
  const url = `${BASE}/site/search?query=${encodeURIComponent(searchTerm)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    // A name with no hits is redirected by the site to /site/search-all, which shows the "не найдена" page.
    const html = await res.text();
    const cards = parseCards(html);
    const titleCount = Number((html.match(/class="result-title"[^>]*>[^<]*\((\d+)\)/) || [])[1]);
    const hasTitle = /class="result-title"/.test(html);

    if (cards.length) {
      const matches = cards.filter((c) => nameKey(c.name) === wantKey);
      if (matches.length) {
        return {
          status: 'found', reason: '', records: matches, source_url: url,
          excerpt: `${matches.length} exact match on the site: ${matches.map((c) => c.name).join('; ')}`.slice(0, 500),
        };
      }
      if (Number.isFinite(titleCount) && titleCount > cards.length) {
        return {
          status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
          excerpt: `site reports ${titleCount} results but only ${cards.length} are on the page`,
        };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `no exact name among ${cards.length} similar results: ${cards.slice(0, 8).map((c) => c.name).join('; ')}`.slice(0, 500),
      };
    }

    const notFound = html.match(/<div class="h2">([^<]*не найдена)<\/div>/i);
    if (notFound || (hasTitle && titleCount === 0)) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: decode(notFound ? notFound[1] : 'Результаты поиска (0)').slice(0, 300),
      };
    }
    if (/qrator|captcha|капча|доступ ограничен|проверка браузера|access denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: decode(html).slice(0, 300) };
    }
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: decode(html).slice(0, 300) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: url,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
