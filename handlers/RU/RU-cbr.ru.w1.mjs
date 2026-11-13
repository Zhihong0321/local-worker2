export const meta = { task: 'RU-cbr.ru', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'registration_number', 'ogrn', 'legal_form', 'registration_date', 'license_status', 'address', 'org_type', 'detail_url'],
  canary: { found: 'ООО КБ "Алтайкапиталбанк"', not_found: 'Несуществующий Банк Тестовый' } };

// One public HTML page: the Bank of Russia list of credit organisations (banks and non-bank credit organisations).
const LIST_URL = 'https://www.cbr.ru/banking_sector/credit/FullCoList/';
const BASE = 'https://www.cbr.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form and bank-type words that are dropped before comparing names ("ООО КБ «X»" == "X").
const DROP_WORDS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нпао', 'ип', 'кб', 'нко', 'рнко']);

const ENTITIES = { amp: '&', quot: '"', laquo: '"', raquo: '"', nbsp: ' ', ndash: '-', mdash: '-', lt: '<', gt: '>', '#39': "'" };

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e] : m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare-key for a company name: case, ё/е, punctuation and legal-form words ignored. */
function normalizeName(str) {
  return cleanText(str)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !DROP_WORDS.has(t))
    .join('');
}

/** Rows of the register table as objects. Returns null when the table is not there. */
function parseRegister(html) {
  const table = html.match(/<table class="data levels"[\s\S]*?<\/table>/)?.[0];
  if (!table || !table.includes('Наименование') || !table.includes('ОГРН')) return null;
  const rows = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g);
    if (!cells || cells.length < 9) continue; // header row has <th> only
    const c = cells.map((td) => td.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, ''));
    const href = c[4].match(/href="([^"]*finorg\/foinfo\/[^"]*)"/i)?.[1] || '';
    rows.push({
      name: cleanText(c[4]),
      registration_number: cleanText(c[2]),
      ogrn: cleanText(c[3]),
      legal_form: cleanText(c[5]),
      registration_date: cleanText(c[6]),
      license_status: cleanText(c[7]),
      address: cleanText(c[8]),
      org_type: cleanText(c[1]),
      detail_url: href ? new URL(href.replace(/&amp;/g, '&'), BASE).href : '',
    });
  }
  return rows.length ? rows : null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (/captcha/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'captcha page' };
    }
    const rows = parseRegister(html);
    if (!rows) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }
    const want = normalizeName(name);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'no company name left after removing legal-form words' };
    }
    const matches = rows.filter((r) => normalizeName(r.name) === want);
    if (!matches.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No entry named "${name}" in the Bank of Russia list of credit organisations (${rows.length} entries). Other registers on this site (insurers, brokers, funds, microfinance) are not checked by this handler.`,
      };
    }
    return {
      status: 'found', reason: '', records: matches, source_url: LIST_URL,
      excerpt: `${matches.length} match(es) in the Bank of Russia list of credit organisations: ${matches[0].name}, ОГРН ${matches[0].ogrn}, ${matches[0].license_status}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
