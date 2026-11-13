export const meta = { task: 'RU-cnews.ru', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['headline', 'date', 'section', 'url'],
  canary: { found: 'Яндекс', not_found: 'Несуществующая Компания Ромашка Холдинг' } };

// CNews publishes no company register. Its site search returns news headlines; a company counts as found only when
// at least one headline on the first results page names it (legal form removed, case and ё/е ignored).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['пао', 'оао', 'зао', 'ао', 'ооо', 'ип', 'гк', 'нко', 'фгуп', 'гуп', 'муп', 'llc', 'ltd', 'inc', 'jsc', 'pjsc', 'ojsc', 'corp', 'gmbh', 'plc', 'sdn', 'bhd']);

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function decode(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&laquo;|&raquo;|&quot;|&ldquo;|&rdquo;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Keep the name as typed (case kept), without quotes and without the legal form. */
function searchText(keyword) {
  return String(keyword || '').replace(/[«»"“”„]/g, ' ').split(/\s+/)
    .filter((t) => t && !LEGAL.has(norm(t))).join(' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = 'https://www.cnews.ru/search?search=';
  try {
    const query = searchText(keyword);
    const core = norm(query);
    if (core.length < 2) return fail('other', searchUrl, 'name too short after removing the legal form');
    searchUrl = 'https://www.cnews.ru/search?search=' + encodeURIComponent(query);

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const items = [...html.matchAll(/<a\s+href="([^"]+)"\s+class="ani-postname">([\s\S]*?)<\/a>/g)]
      .map((m) => ({ href: m[1], title: decode(m[2]) }));

    if (items.length === 0) {
      if (html.includes('Ничего не найдено')) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'Ничего не найдено' };
      }
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      if (/just a moment|attention required|access denied|captcha|проверка|доступ/i.test(title)) {
        return fail('blocked', searchUrl, 'bot check page: ' + title.slice(0, 120));
      }
      return fail('layout_changed', searchUrl, html.slice(0, 300));
    }

    const re = new RegExp('(^|\\s)' + escapeRe(core));
    const matches = items.filter((it) => re.test(norm(it.title)));
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `CNews returned ${items.length} headlines for "${query}", none names the company`,
      };
    }

    const records = matches.map((it) => {
      const url = new URL(it.href, 'https://www.cnews.ru/').href;
      const date = (url.match(/(\d{4}-\d{2}-\d{2})_/) || [])[1] || '';
      const section = (url.match(/cnews\.ru\/([a-z]+\/[a-z]+)\//) || [])[1] || '';
      return { headline: it.title, date, section, url };
    });

    return { status: 'found', reason: '', records, source_url: searchUrl, excerpt: records[0].headline.slice(0, 300) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err).slice(0, 300));
  }
}
