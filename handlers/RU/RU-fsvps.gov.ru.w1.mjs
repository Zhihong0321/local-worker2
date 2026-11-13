export const meta = {
  task: 'RU-fsvps.gov.ru',
  want: 'w1',
  tier: 2,
  method: 'other',
  pdf: false,
  input: 'company name',
  fields: ['number', 'names', 'address', 'entry_date'],
  canary: { found: 'ООО "ТК "Мираторг"', not_found: 'ООО Несуществующая Проверка Тест' },
};

// Cerberus (cerberus.vetrf.ru) is the registry that fsvps.gov.ru links from its "Реестр организаций" page
// ("Реестр предприятий Таможенного союза в системе «Цербер»"). The anonymous search is a JSON POST whose
// answer is an HTML table. The page sends the search params wrapped in {"data": {...}}.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_URL = 'https://cerberus.vetrf.ru/cerberus/certified/pub';
const SEARCH_URL = 'https://cerberus.vetrf.ru/cerberus/certified/pub?c=0&clear=true';

const LEGAL_PHRASES = [
  /общество\s+с\s+ограниченной\s+ответственностью/giu,
  /открытое\s+акционерное\s+общество/giu,
  /закрытое\s+акционерное\s+общество/giu,
  /публичное\s+акционерное\s+общество/giu,
  /акционерное\s+общество/giu,
  /индивидуальный\s+предприниматель/giu,
];
const LEGAL_TOKENS = /(?<![\p{L}\p{N}])(ооо|оао|зао|пао|ао|ип|llc|ltd|jsc)(?![\p{L}\p{N}])/giu;

/** The company name without legal form, quotes and punctuation, lower case, ё -> е. */
function core(name) {
  let s = String(name || '').toLowerCase().replace(/ё/g, 'е');
  for (const re of LEGAL_PHRASES) s = s.replace(re, ' ');
  s = s.replace(LEGAL_TOKENS, ' ');
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Comparison key: the core name with all spaces removed. */
function key(name) {
  return core(name).replace(/\s+/g, '');
}

/** Visible text of an HTML fragment, with the entities this site uses decoded. */
function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;|&#34;|&laquo;|&raquo;|&#171;|&#187;/gi, '"')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAME_END = /(?=\s(?:Юр\. адрес:|Фактический адрес:|Вид предприятия:|Название:|Номер:)|$)/;

function parseRows(html) {
  const records = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const text = clean(row);
    const num = text.match(/Номер:\s*([A-Za-z0-9][A-Za-z0-9/.\-]*)/);
    if (!num) continue;
    const names = [];
    const nameRe = new RegExp('Название:\\s*(.+?)' + NAME_END.source, 'g');
    let m;
    while ((m = nameRe.exec(text)) !== null) {
      const v = m[1].trim();
      if (v && !names.includes(v)) names.push(v);
    }
    const addr = text.match(/Фактический адрес:\s*(.+?)(?=\s(?:Вид предприятия:|Название:|Юр\. адрес:|Номер:)|$)/);
    const date = text.match(/внесён:\s*(\d{2}\.\d{2}\.\d{4})/);
    records.push({
      number: num[1],
      names,
      address: addr ? addr[1].trim() : '',
      entry_date: date ? date[1] : '',
    });
  }
  return records;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await run(keyword);
  // On this Windows Node build the runner aborts (exit 127) after printing its answer when the HTTP socket is
  // still open at exit. A short wait after the response lets the socket close first. Total stays under 60 s.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return result;
}

async function run(keyword) {
  try {
    const wanted = key(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
        excerpt: 'no company name left after removing the legal form' };
    }
    // The server matches a plain substring of the name, so search by the longest word of the core name.
    const word = core(keyword).split(' ').reduce((a, b) => (b.length > a.length ? b : a), '');

    const body = {
      data: {
        itemPerPageCount: '50', objectNumbers: null, name: word, latinName: '', businessEntityInnOgrn: '',
        addressView: '', productStatusInfoStateList: ['CURRENT'], registryStatusList: ['VERIFIED'],
        certifiedStatusList: [], countries: [], regions: [], districts: [], supervisedObjectTypeGuidList: [],
        certifiedActivityIdList: [], productTypeId: null, productGuid: null, subProductGuid: null,
      },
    };

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE_URL,
        'Accept': 'text/html, */*; q=0.01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (html.includes('idp.vetrf.ru') || html.includes('SAMLRequest')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: 'login (SAML) page returned' };
    }
    if (html.includes('непредвиденная') || html.includes('непредвиденная ошибка')) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'the site returned its error page' };
    }

    const text = clean(html);
    const totalMatch = text.match(/Записи с\s*\d+\s*по\s*\d+\s*из\s*(\d+)/);
    if (!totalMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: text.slice(0, 300) };
    }
    const total = Number(totalMatch[1]);
    const rows = parseRows(html);

    const hits = rows.filter((r) => r.names.some((n) => key(n) === wanted));
    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits,
        source_url: PAGE_URL,
        excerpt: `${hits.length} record(s) match "${keyword}" (search term "${word}", ${total} result(s) in total)`,
      };
    }
    if (total > rows.length) {
      // The company could be among results on the next pages, which this handler does not read.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
        excerpt: `no exact match in the first ${rows.length} of ${total} results for "${word}"` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `0 matching records for "${keyword}" (search term "${word}", ${total} result(s) in total)`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
