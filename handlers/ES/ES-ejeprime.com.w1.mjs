export const meta = {
  task: 'ES-ejeprime.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'author', 'summary', 'url'],
  canary: { found: 'Colonial', not_found: 'Inmobiliaria Zorzal Ficticia S.L.' },
};

const BASE = 'https://www.ejeprime.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 5;
const DEADLINE_MS = 45000;

// Legal-form words that never identify a company by themselves.
const LEGAL = new Set(['sa', 'sl', 'sau', 'slu', 'sab', 'sociedad', 'anonima', 'limitada', 'socimi', 'coop',
  'sdn', 'bhd', 'ltd', 'llc', 'inc', 'plc', 'gmbh', 'srl', 'spa', 's', 'a', 'l', 'u']);
// Words that many companies share; they are used for matching only when nothing else is left.
const GENERIC = new Set(['inmobiliaria', 'inmobiliarias', 'grupo', 'group', 'holding', 'holdings', 'real', 'estate',
  'espana', 'spain', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'and', 'the', 'compania', 'company', 'promotora',
  'promociones', 'desarrollos', 'property', 'properties', 'servicios', 'gestion', 'inversiones', 'patrimonial']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ntilde: 'ñ', Ntilde: 'Ñ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', Aacute: 'Á', Eacute: 'É',
  Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Uuml: 'Ü', ordf: 'ª', ordm: 'º', iquest: '¿', iexcl: '¡',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', euro: '€', ccedil: 'ç' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in NAMED ? NAMED[n] : m));
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function tokens(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
}

/** The words of the typed name, legal form and generic words removed where something else is left. */
function nameWords(name) {
  const words = String(name || '').replace(/\./g, '').split(/[\s,;]+/).filter(Boolean);
  const keyOf = (w) => fold(w).replace(/[^a-z0-9]/g, '');
  const distinctive = words.filter((w) => keyOf(w) && !LEGAL.has(keyOf(w)));
  const strong = distinctive.filter((w) => !GENERIC.has(keyOf(w)));
  return { strong: strong.length ? strong : distinctive, keys: (strong.length ? strong : distinctive).map(keyOf) };
}

function parseItems(html) {
  const items = [];
  const parts = html.split('<article class="news_list_item');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const t = block.match(/<a href="([^"]+)" class="title"[^>]*>([\s\S]*?)<\/a>/);
    if (!t) continue;
    const date = block.match(/<p class="date">([\s\S]*?)<\/p>/);
    const author = block.match(/<p class="author">([\s\S]*?)<\/p>/);
    const text = block.match(/<div class="text">([\s\S]*?)<\/div>/);
    items.push({
      title: clean(t[2]),
      date: date ? clean(date[1]) : '',
      author: author ? clean(author[1]) : '',
      summary: text ? clean(text[1]) : '',
      url: new URL(decode(t[1]), BASE).href,
    });
  }
  return items;
}

function lastPage(html) {
  const nums = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });
  try {
    const { strong, keys } = nameWords(keyword);
    if (!keys.length) return fail('other', BASE, 'no word is left in the name after removing the legal form');
    const term = strong.join(' ');
    const urlFor = (page) => `${BASE}/buscar?term=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;

    const records = [];
    let seen = 0;
    let totalPages = 1;
    let stoppedEarly = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > DEADLINE_MS) { stoppedEarly = true; break; }
      const url = urlFor(page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (!/hemeroteca de EjePrime|news_list_wrapper/.test(html)) {
        if (/captcha|challenge-platform|Attention Required|Access denied/i.test(html)) return fail('blocked', url, 'bot or captcha page');
        return fail('layout_changed', url, clean(html).slice(0, 300));
      }
      if (page === 1) totalPages = lastPage(html);

      const items = parseItems(html);
      seen += items.length;
      for (const it of items) {
        const have = new Set(tokens(`${it.title} ${it.summary}`));
        if (keys.every((k) => have.has(k))) records.push(it);
      }
      if (items.length === 0 || page >= totalPages) break;
    }

    const firstUrl = urlFor(1);
    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${records.length} article(s) name "${term}" in the headline or summary: ${records[0].date} ${records[0].title}`.slice(0, 500),
      };
    }
    if (stoppedEarly || totalPages > MAX_PAGES) {
      return fail('other', firstUrl, `the site has ${totalPages} result pages; the first ${MAX_PAGES} were read and none names the company`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: seen === 0
        ? `0 articles for "${term}"`
        : `${seen} loosely matching article(s) for "${term}", none names the company in its headline or summary`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', BASE, String((err && err.message) || err).slice(0, 300));
  }
}
