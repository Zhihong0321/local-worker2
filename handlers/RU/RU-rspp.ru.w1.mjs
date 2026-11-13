export const meta = {
  task: 'RU-rspp.ru',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list_no', 'website', 'registry', 'match'],
  canary: { found: 'ОАО "ЛУКОЙЛ"', not_found: 'ООО "Ромашка Тестовая Компания"' },
};

// rspp.ru publishes the "Реестр организаций-участников Социальной хартии" (participants of the Social Charter of
// Russian business). The page shows 5 rows; its own "Показать всё" button POSTs ajaxLoad=Y to the same address and
// receives the whole list (281 rows at the time of writing) in one response. This handler does that same POST.
const REGISTRY_URL = 'https://rspp.ru/about/registries/';
const LIST_URL = 'https://rspp.ru/about/registries/?PAGEN_38093=2&ID=38093&PROP_ID=85';
const REGISTRY_NAME = 'Social Charter participants register (rspp.ru)';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_ROWS = 50; // the list has ~281 rows; far fewer means the page is not the list we expect

const LEGAL_PHRASES = [
  ['общество с ограниченной ответственностью', 'ооо'],
  ['открытое акционерное общество', 'оао'],
  ['закрытое акционерное общество', 'зао'],
  ['публичное акционерное общество', 'пао'],
  ['акционерное общество', 'ао'],
  ['некоммерческая организация', 'но'],
  ['индивидуальный предприниматель', 'ип'],
];
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'но', 'ип', 'тоо', 'ано', 'нко', 'нп', 'чоу', 'гуп', 'муп', 'фгуп', 'нао', 'одо']);

/** Normalised comparison key: lower case, ё=е, no numbering, no punctuation or quotes, no legal form. */
function nameKey(str) {
  let s = (str || '').toLowerCase().replace(/ё/g, 'е').replace(/^\s*\d+\.\s*/, '');
  for (const [long, short] of LEGAL_PHRASES) s = s.split(long).join(short);
  const parts = s.replace(/[^a-zа-я0-9\s]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (parts.length && LEGAL_FORMS.has(parts[0])) parts.shift();
  while (parts.length && LEGAL_FORMS.has(parts[parts.length - 1])) parts.pop();
  return parts.join('');
}

/** Brand key: the last quoted segment of the register name (e.g. "Норильский никель" in ОАО "Горно-... "Норильский никель""). */
function brandKey(name) {
  const s = (name || '').replace(/["»”]+\s*$/, ''); // drop the closing quote(s) of the brand
  const i = Math.max(s.lastIndexOf('"'), s.lastIndexOf('«'), s.lastIndexOf('“'), s.lastIndexOf('„'));
  return i < 0 ? '' : nameKey(s.slice(i + 1));
}

function decode(s) {
  return s
    .replace(/&quot;/gi, '"').replace(/&laquo;|&raquo;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&mdash;/gi, '-').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: REGISTRY_URL, excerpt: 'empty company name' };
    }
    // The register lists Russian-language legal names. A Latin-only name cannot be matched against it reliably,
    // so it is reported as couldnt_check rather than as a false not_found.
    if (!/[а-яА-ЯёЁ]/.test(kw)) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: REGISTRY_URL,
        excerpt: 'the register lists Russian-language names; a Latin-script name cannot be matched here',
      };
    }

    const res = await fetch(LIST_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': REGISTRY_URL,
      },
      body: 'ajaxLoad=Y',
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: REGISTRY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: REGISTRY_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const rowHtml = html.match(/<tr[^>]*class="[^"]*ajax-rows[^"]*"[\s\S]*?<\/tr>/g) || [];
    if (rowHtml.length < MIN_ROWS) {
      return {
        status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: REGISTRY_URL,
        excerpt: `expected the register rows, got ${rowHtml.length} rows; ` + cleanText(html).slice(0, 200),
      };
    }

    const rows = rowHtml.map((r) => {
      const cells = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(cleanText);
      const numbered = cells[0] || '';
      const m = numbered.match(/^(\d+)\.\s*(.*)$/);
      return { list_no: m ? m[1] : '', name: m ? m[2] : numbered, website: cells[1] || '' };
    }).filter((r) => r.name);

    const want = nameKey(kw);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: REGISTRY_URL, excerpt: 'name has no comparable letters' };
    }

    // Pass 1: the full legal name, normalised. Pass 2 (only if pass 1 is empty): the brand name alone, normalised,
    // for users who type the short name without the legal form and the descriptive words.
    let matches = rows.filter((r) => nameKey(r.name) === want).map((r) => ({ ...r, match: 'full name' }));
    if (matches.length === 0) {
      matches = rows.filter((r) => brandKey(r.name) && brandKey(r.name) === want).map((r) => ({ ...r, match: 'brand name' }));
    }
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: REGISTRY_URL,
        excerpt: `checked ${rows.length} entries of the ${REGISTRY_NAME}; no exact name or brand-name match`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((r) => ({ name: r.name, list_no: r.list_no, website: r.website, registry: REGISTRY_NAME, match: r.match })),
      source_url: REGISTRY_URL,
      excerpt: `listed in the ${REGISTRY_NAME}: ` + matches.map((r) => `${r.list_no}. ${r.name} (${r.match})`).join('; ').slice(0, 400),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: REGISTRY_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
