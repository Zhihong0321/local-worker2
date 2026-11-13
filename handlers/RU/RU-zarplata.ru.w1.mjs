export const meta = {
  task: 'RU-zarplata.ru',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'employer_id', 'url', 'vacancies'],
  canary: { found: '1я Клининговая Уфа', not_found: 'Несуществующая Компания Тестовая' },
};

const BASE = 'https://zarplata.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5' };
const MAX_PAGES = 5;          // 100 employers per page; 5 pages = 500 search results
const DEADLINE_MS = 40000;    // stop paging well before the 60 s limit

// Legal forms (Russian and a few English) that are dropped before comparing names.
const LEGAL_FORMS = /(?<!\p{L})(общество с ограниченной ответственностью|публичное акционерное общество|открытое акционерное общество|закрытое акционерное общество|акционерное общество|индивидуальный предприниматель|ооо|оао|зао|пао|ао|ип|нко|ано|гуп|муп|фгуп|llc|ltd|jsc|inc)(?!\p{L})/gu;

/** Comparable form of a company name: lower case, ё=е, no quotes/punctuation, no legal form. */
function core(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'“”„`]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(LEGAL_FORMS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function searchUrl(keyword, page) {
  const p = page > 0 ? `&page=${page}` : '';
  return `${BASE}/employers_list?query=${encodeURIComponent(keyword)}&areaId=113${p}`;
}

const BOT_CHECK = /VPN мешает работе сайта|vpncheeck|smartcaptcha|captcha/i;

/** Fetch one search page. Returns { html } or { fail: { status, reason, excerpt, url } }. */
async function getPage(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    const target = new URL(loc, url).href;
    if (BOT_CHECK.test(loc)) return { fail: { reason: 'blocked', excerpt: `redirected to a VPN/bot check: ${target}`, url } };
    return { fail: { reason: 'layout_changed', excerpt: `unexpected redirect (HTTP ${res.status}) to ${target}`, url } };
  }
  if ([403, 429, 451].includes(res.status)) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}`, url } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}`, url } };
  const html = await res.text();
  if (BOT_CHECK.test(html.slice(0, 20000))) return { fail: { reason: 'blocked', excerpt: 'VPN/bot check page instead of search results', url } };
  if (!/data-qa="employer-name-text"|data-qa="empty-search-block"/.test(html)) {
    return { fail: { reason: 'layout_changed', excerpt: cleanText(html).slice(0, 300), url } };
  }
  return { html };
}

/** Read every employer card on one results page. */
function parseCards(html) {
  const cards = [];
  const re = /<a\b[^>]*data-qa="employer-name"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = (m[0].match(/href="\/employer\/(\d+)/) || [])[1];
    const nameHtml = (m[1].match(/data-qa="employer-name-text"[^>]*>([\s\S]*?)<\/span>/) || [])[1];
    if (!id || !nameHtml) continue;
    const name = cleanText(nameHtml);
    const tail = html.slice(m.index, m.index + 3000);
    const counter = (tail.match(/data-qa="employer-counter-\d+"[\s\S]*?<span[^>]*>([^<]*)<\/span>/) || [])[1];
    cards.push({ name, id, vacancies: cleanText(counter || '') });
  }
  return cards;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const firstUrl = searchUrl(keyword, 0);
  try {
    const want = core(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'empty company name' };
    }

    const matches = [];
    let page = 0;
    let morePages = false;
    let total = 0;
    let firstHtml = '';

    for (;;) {
      const r = await getPage(searchUrl(keyword, page));
      if (r.fail) {
        return { status: 'couldnt_check', reason: r.fail.reason, records: [], source_url: r.fail.url, excerpt: r.fail.excerpt };
      }
      if (page === 0) firstHtml = r.html;
      const cards = parseCards(r.html);
      total += cards.length;
      for (const c of cards) {
        const candidates = [core(c.name), core(c.name.replace(/\([^)]*\)/g, ' '))];
        if (candidates.includes(want)) {
          matches.push({ name: c.name, employer_id: c.id, url: `${BASE}/employer/${c.id}`, vacancies: c.vacancies });
        }
      }
      morePages = /data-qa="pager-next"/.test(r.html) && cards.length > 0;
      page += 1;
      if (!morePages || page >= MAX_PAGES || Date.now() - started > DEADLINE_MS) break;
    }

    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${first.name}${first.vacancies ? ' - ' + first.vacancies : ''}`.slice(0, 500),
      };
    }

    if (morePages) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: firstUrl,
        excerpt: `no exact match in the first ${page} pages of results (${total} employers); the search has more pages`,
      };
    }

    const emptyBlock = /data-qa="empty-search-block"/.test(firstHtml) && total === 0;
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: emptyBlock ? 'Ничего не нашлось (search returned no employers)' : `${total} employers listed, none with this name`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
