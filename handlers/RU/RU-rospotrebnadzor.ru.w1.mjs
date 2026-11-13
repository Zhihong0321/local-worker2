export const meta = {
  task: 'RU-rospotrebnadzor.ru', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'short_name', 'inn', 'ogrn', 'license_number', 'status', 'legal_address', 'activity', 'order', 'registry_updated'],
  canary: { found: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "СИБПРОМТРАНС"', not_found: 'ООО "НЕСУЩЕСТВУЮЩАЯ КОМПАНИЯ ТЕСТ"' },
};

const BASE = 'https://fp.rospotrebnadzor.ru/licen/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form wording as the register and users write it. Whole phrases are removed anywhere in the name;
// the short abbreviations only at the start (so a name that merely contains "АО" is not cut).
const LEGAL_PHRASES = [
  'ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ', 'ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ',
  'МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ', 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ',
  'ОТКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО',
  'АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', 'НЕКОММЕРЧЕСКОЕ ПАРТНЕРСТВО',
];
const LEGAL_ABBR = ['ООО', 'ОАО', 'ЗАО', 'ПАО', 'АО', 'НАО', 'ИП', 'ГУП', 'МУП', 'ФГУП', 'АНО', 'НКО'];

function decode(s) {
  return String(s || '')
    .replace(/&quot;/gi, '"').replace(/&laquo;|&raquo;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(s) {
  return decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Legal form removed, quotes and wildcards removed, upper case: the part of the name that identifies the company. */
function coreName(s) {
  let t = clean(s).toUpperCase().replace(/Ё/g, 'Е').replace(/[«»"“”„'`*?]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const p of LEGAL_PHRASES) t = t.split(p).join(' ');
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of LEGAL_ABBR) {
      if (t === a || t.startsWith(a + ' ')) { t = t.slice(a.length).trim(); changed = true; }
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Letters and digits only, for comparing two names. */
function compareKey(core) {
  return core.replace(/[^\p{L}\p{N}]/gu, '');
}

function searchUrl(term) {
  return `${BASE}?oper=search&numb=&numb_history=&firmget_name=${encodeURIComponent(term)}&ogrn_inn_nza=&service_list=`;
}

function parseBlocks(html) {
  const starts = [];
  const re = /<b>\d+\. Актуальная запись в реестре<\/b>/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((s, i) => html.slice(s, i + 1 < starts.length ? starts[i + 1] : html.length));
}

function parseRecord(block) {
  const one = (re) => { const m = block.match(re); return m ? clean(m[1]) : ''; };
  const licensee = one(/Лицензиат — <b>([^<]*)<\/b>/);
  if (!licensee) return null; // a block without a licensee means the layout changed
  const order = block.match(/о предоставлении лицензии — от <b>([^<]*)<\/b>\s*№\s*<b>([^<]*)<\/b>/);
  return {
    name: licensee,
    short_name: one(/Лицензиат —[\s\S]*?\(<b>([^<]*)<\/b>\)/),
    inn: one(/ИНН Лицензиата — <b>([^<]*)<\/b>/),
    ogrn: one(/ОГРН Лицензиата — <b>([^<]*)<\/b>/),
    license_number: one(/Номер лицензии в ЕРУЛ[^<]*<b>([^<]*)<\/b>/),
    status: one(/Статус лицензии[\s\S]*?<b>([\s\S]*?)<\/b>/),
    legal_address: one(/Юридический адрес — <b>([^<]*)<\/b>/),
    activity: one(/Вид деятельности — <b>([^<]*)<\/b>/),
    order: order ? `${clean(order[1])} № ${clean(order[2])}` : '',
    registry_updated: one(/Актуальная запись в реестре<\/b>\s*\(от ([^)]*)\)/),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = '';
  try {
    const core = coreName(keyword);
    if (!compareKey(core)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no company name left after removing the legal form' };
    }
    // The register treats * and ? as wildcards, so the search term never carries them.
    url = searchUrl(core);

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    const isSearchPage = html.includes('firmget_name') && html.includes('Для получения информации по реестровой записи');
    if (!isSearchPage) {
      if (/captcha|капча|доступ запрещ|access denied|проверка браузера|ddos-guard/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: clean(html).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: clean(html).slice(0, 300) };
    }

    const parsed = parseBlocks(html).map(parseRecord);
    if (parsed.some((r) => r === null)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'a result without a licensee line' };
    }

    const want = compareKey(core);
    const matches = parsed.filter((r) => {
      const keys = [r.name, r.short_name].map((n) => compareKey(coreName(n)));
      return keys.includes(want);
    });

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: parsed.length
          ? `${parsed.length} register records matched "${core}" but none has this exact name`
          : `0 register records for "${core}"`,
      };
    }

    return {
      status: 'found', reason: '', records: matches, source_url: url,
      excerpt: clean(`${matches[0].name} ${matches[0].license_number} ${matches[0].status} ${matches[0].activity}`).slice(0, 400),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [],
      source_url: url, excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
