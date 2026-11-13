export const meta = {
  task: 'RU-spark.ru',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'description'],
  canary: { found: 'Ашманов и партнеры', not_found: 'Ромашка Зетта Нонекзистент' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ооо', 'ао', 'оао', 'зао', 'пао', 'нко', 'ано', 'ип', 'тоо', 'llc', 'ltd', 'jsc', 'gmbh']);
const BLOCK_RE = /captcha|cf-chl|checking your browser|access denied|Доступ ограничен|подтвердите, что вы не робот/i;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(s) {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, ё/е, punctuation and legal form removed. */
function normalize(str) {
  const s = decodeEntities(str || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s.split(/\s+/).filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

/** What to type into the site search: the name without quotes and without the legal form (the site returns 0 for "ООО"). */
function searchTerms(name) {
  return (name || '').replace(/[«»"“”„'`]/g, ' ').split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '')))
    .join(' ');
}

/** The "Проекты" tab of the search page: its total count and the project cards shown in it. */
function projectTab(html) {
  const head = html.search(/Проекты\s*<b>\s*(\d+)\s*<\/b>/);
  if (head < 0) return null;
  const total = parseInt(html.slice(head).match(/<b>\s*(\d+)/)[1], 10);
  const secStart = html.indexOf('<section', head);
  const secEnd = secStart < 0 ? -1 : html.indexOf('</section>', secStart);
  const block = secStart < 0 ? '' : html.slice(secStart, secEnd < 0 ? undefined : secEnd);
  const items = [];
  const re = /<a class="item clear" href="(\/startup\/[^"\/?#]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const title = m[2].match(/<div class="title">([\s\S]*?)<\/div>/);
    const desc = m[2].match(/<div class="desc[^"]*">([\s\S]*?)<\/div>/);
    items.push({ path: m[1], name: cleanText(title ? title[1] : ''), description: cleanText(desc ? desc[1] : '') });
  }
  return { total, items };
}

function fail(status, reason, searchUrl, excerpt) {
  return { status, reason, records: [], source_url: searchUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const query = searchTerms(input);
  const searchUrl = `https://spark.ru/search?q=${encodeURIComponent(query)}`;
  try {
    if (!query) return fail('couldnt_check', 'other', searchUrl, 'no name left to search after removing the legal form');

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (BLOCK_RE.test(html)) return fail('couldnt_check', 'blocked', searchUrl, 'bot check or captcha page');
    if (!html.includes('Результаты поиска по запросу') || !html.includes('accordion-tabs')) {
      return fail('couldnt_check', 'layout_changed', searchUrl, cleanText(html).slice(0, 300));
    }

    const tab = projectTab(html);
    // No "Проекты" tab at all: the site answered with an empty result page.
    if (!tab) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
               excerpt: `0 project results for "${input}"` };
    }

    const target = normalize(input);
    if (!target) return fail('couldnt_check', 'other', searchUrl, 'no letters left after removing the legal form');

    const matches = tab.items.filter((it) => normalize(it.name) === target);
    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map((it) => ({
          name: it.name,
          url: new URL(it.path, 'https://spark.ru').href,
          description: it.description,
        })),
        source_url: searchUrl,
        excerpt: `${first.name}: ${first.description}`.slice(0, 300),
      };
    }

    // No exact match on the page. If the site has more project results than the page shows,
    // the absence is not proven, so this is not a not_found.
    if (tab.total > tab.items.length) {
      return fail('couldnt_check', 'other', searchUrl,
        `only the first ${tab.items.length} of ${tab.total} project results are on the page; no exact match among them`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `${tab.total} project results for "${input}", none with this name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail('couldnt_check', timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
