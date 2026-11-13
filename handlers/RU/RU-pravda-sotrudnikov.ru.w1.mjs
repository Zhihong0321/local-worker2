export const meta = {
  task: 'RU-pravda-sotrudnikov.ru',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'phones', 'email'],
  canary: { found: 'Сбербанк России', not_found: 'Зюзинский Ромашка Тестовый Квартал' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://pravda-sotrudnikov.ru';
const MAX_PAGES = 10;
const STOP_NEW_PAGE_AFTER_MS = 30000;

// Russian legal-form words. The site's search returns nothing when a legal form is typed in the query,
// so they are removed from the query, and from both names before they are compared.
const LEGAL_FORM_PHRASES = [
  'общество с ограниченной ответственностью',
  'открытое акционерное общество',
  'закрытое акционерное общество',
  'публичное акционерное общество',
  'непубличное акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'автономная некоммерческая организация',
  'некоммерческая организация',
  'государственное унитарное предприятие',
  'муниципальное унитарное предприятие',
];
const LEGAL_FORM_WORDS = ['ооо', 'оао', 'зао', 'ао', 'пао', 'нао', 'ип', 'тоо', 'ано', 'нко', 'гуп', 'муп', 'фгуп'];

function stripLegalForm(text) {
  let s = (text || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”'`]/g, ' ');
  for (const phrase of LEGAL_FORM_PHRASES) s = s.split(phrase).join(' ');
  const words = s.split(/\s+/).filter((w) => w && !LEGAL_FORM_WORDS.includes(w.replace(/[.,]/g, '')));
  return words.join(' ').trim();
}

function normaliseForCompare(text) {
  return stripLegalForm(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

const ENTITIES = { amp: '&', quot: '"', laquo: '«', raquo: '»', nbsp: ' ', lt: '<', gt: '>', '#039': "'", apos: "'" };
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => (ENTITIES[name] !== undefined ? ENTITIES[name] : m));
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function headers() {
  return { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5' };
}

function searchUrl(query, page) {
  const q = 'q=' + encodeURIComponent(query);
  return page > 1 ? `${BASE}/search?${q}&page=${page}` : `${BASE}/search?${q}`;
}

/** Parse the company cards of one search results page. */
function parseCards(html) {
  const cards = [];
  const parts = html.split('class="mdc-companies-item-container"').slice(1);
  for (const part of parts) {
    const link = part.match(/<div class="mdc-companies-item-title">[\s\S]*?<a href="(\/company\/[^"]+)">([\s\S]*?)<\/a>/);
    if (!link) continue;
    const name = cleanText(link[2]);
    // The card's contact block ends at the first "</div></div>" after its start.
    const block = (part.match(/mdc-companies-item-text">([\s\S]*?)<\/div>\s*<\/div>/) || [, ''])[1];
    const phonesBlock = block.match(/mdc-companies-item-text-label">Телефоны:<\/span>([\s\S]*?)<\/div>/);
    const phones = phonesBlock ? cleanText(phonesBlock[1]) : '';
    const mail = block.match(/href="mailto:([^"]+)"/i);
    cards.push({
      name,
      url: new URL(link[1], BASE).href,
      phones,
      email: mail ? decodeEntities(mail[1]).trim() : '',
      text: cleanText(`${name} ${block}`).slice(0, 300),
    });
  }
  return cards;
}

function hasNextPage(html) {
  return /<li class="next">\s*<a /.test(html);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows can abort on process.exit() right after a fetch, while the socket is still closing.
  // A short pause lets the socket settle before the caller exits. The answer is already final.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  let query = stripLegalForm(input);
  if (!query) query = input;
  const target = normaliseForCompare(input);
  const firstUrl = searchUrl(query, 1);

  if (!target) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'no company name in the input' };
  }

  try {
    const matches = [];
    let sawAnyCard = false;
    let pagesRead = 0;
    let lastHasNext = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > STOP_NEW_PAGE_AFTER_MS) {
        return {
          status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl(query, page - 1),
          excerpt: `stopped after ${pagesRead} page(s) to keep under 60 s; more results exist`,
        };
      }

      const url = searchUrl(query, page);
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(25000) });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      pagesRead = page;

      if (!html.includes('Результаты поиска')) {
        if (/captcha|just a moment|cf-chl|доступ ограничен/i.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }

      const cards = parseCards(html);
      if (cards.length) sawAnyCard = true;
      for (const card of cards) {
        if (normaliseForCompare(card.name) === target) matches.push({ ...card, page_url: url });
      }

      lastHasNext = hasNextPage(html);
      if (!cards.length || !lastHasNext) break;
      if (page === MAX_PAGES && lastHasNext) {
        return {
          status: 'couldnt_check', reason: 'other', records: [], source_url: url,
          excerpt: `search has more than ${MAX_PAGES} pages; not all were checked`,
        };
      }
    }

    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ page_url, text, ...rec }) => rec),
        source_url: first.page_url,
        excerpt: first.text,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: sawAnyCard
        ? `search for "${query}" returned company cards, none with the name "${input}" (${pagesRead} page(s))`
        : `search for "${query}" returned 0 company cards (${pagesRead} page(s))`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
