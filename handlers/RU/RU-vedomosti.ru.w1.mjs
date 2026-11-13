export const meta = { task: 'RU-vedomosti.ru', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['full_name', 'name', 'inn', 'ogrn', 'kpp', 'registration_date', 'legal_address', 'director', 'main_activity', 'profile_url'],
  canary: { found: 'АК АЛРОСА', not_found: 'ЗЗЗ Тестовая Фирма Квакс' } };

const BASE = 'https://www.vedomosti.ru';
const LIST_URL = `${BASE}/companies`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};
// Legal-form words and phrases, stripped from both sides before comparing names.
const LEGAL_FORMS = [
  'публичное акционерное общество', 'закрытое акционерное общество', 'открытое акционерное общество',
  'общество с ограниченной ответственностью', 'акционерное общество', 'акционерная компания',
  'ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ано', 'ип', 'ак',
  'llc', 'jsc', 'pjsc', 'ojsc', 'cjsc', 'ltd', 'limited', 'inc', 'llp', 'plc',
];

/** Lower case, ё→е, punctuation and quotes removed, legal form removed, spaces removed. */
function normalize(str) {
  let s = (str || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  for (let pass = 0; pass < 2; pass++) {
    for (const f of LEGAL_FORMS) s = s.replace(new RegExp(`(^| )${f}( |$)`, 'g'), ' ');
    s = s.replace(/\s+/g, ' ').trim();
  }
  return s.replace(/ /g, '');
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOf(html) {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return decode(noScripts.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The site repeats some values twice ("X X"); keep one copy. */
function dedupe(s) {
  const t = (s || '').trim();
  const h = Math.floor((t.length - 1) / 2);
  if (t.length > 2 && t.slice(0, h).trim() && t.slice(0, h).trim() === t.slice(h + 1).trim()) return t.slice(0, h).trim();
  return t;
}

function pick(txt, re) {
  const m = txt.match(re);
  return m ? m[1].trim() : '';
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

function failureOf(err) {
  return couldnt(err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other', LIST_URL,
    String(err && err.message || err));
}

/** One directory row per company: the list link slug and the name as the site writes it. */
function parseList(html) {
  const out = [];
  const re = /<li class="companies-list__item"[^>]*>\s*<a href="\/companies\/([a-z0-9-]+)"[^>]*>\s*<strong[^>]*>[\s\S]*?<span[^>]*>([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html))) out.push({ slug: m[1], name: decode(m[2]).replace(/\s+/g, ' ').trim() });
  return out;
}

function parseProfile(html, listName, url) {
  const txt = textOf(html);
  // No \b before Cyrillic labels: JavaScript treats Cyrillic letters as non-word characters.
  const inn = (txt.match(/ИНН\s+(\d{10}|\d{12})(?!\d)/) || [])[1] || '';
  const ogrn = (txt.match(/ОГРН\s+(\d{13}|\d{15})(?!\d)/) || [])[1] || '';
  const kpp = (txt.match(/КПП\s+(\d{9})(?!\d)/) || [])[1] || '';
  if (!inn && !ogrn) return null;
  const full_name = dedupe(pick(txt, /Полное наименование компании\s+(.+?)\s+Юридический адрес/));
  const legal_address = dedupe(pick(txt, /Юридический адрес\s+(.+?)\s+(?:Телефон|Руководитель|Дата регистрации)/));
  const director = dedupe(pick(txt, /Руководитель\s+(?!–)(.+?)\s+Дата регистрации/));
  const registration_date = (txt.match(/Дата регистрации\s+(\d{1,2} [^\s]+ \d{4})/) || [])[1] || '';
  const main_activity = dedupe(pick(txt, /Основной вид деятельности\s+(?!–)(.+?)\s+(?:Дополнительные виды деятельности|Материалы о компании)/));
  return { full_name, name: listName, inn, ogrn, kpp, registration_date, legal_address, director, main_activity, profile_url: url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const nk = normalize(keyword);
  if (!nk) return couldnt('other', LIST_URL, 'empty company name');
  try {
    const listRes = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (listRes.status === 403 || listRes.status === 429) return couldnt('blocked', LIST_URL, `HTTP ${listRes.status}`);
    if (!listRes.ok) return couldnt('http_error', LIST_URL, `HTTP ${listRes.status}`);
    const html = await listRes.text();
    if (/captcha|Проверка браузера|checking your browser|Attention Required/i.test(html)) {
      return couldnt('blocked', LIST_URL, 'bot check page');
    }
    if (!html.includes('Справочник компаний') || !html.includes('companies-list__item')) {
      return couldnt('layout_changed', LIST_URL, html.slice(0, 300));
    }
    const entries = parseList(html);
    if (entries.length < 100 || entries.length !== (html.match(/companies-list__item"/g) || []).length) {
      return couldnt('layout_changed', LIST_URL, `parsed ${entries.length} directory rows`);
    }

    const matches = entries.filter((e) => normalize(e.name) === nk);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No row in the Vedomosti company directory matches "${keyword}" (${entries.length} rows checked)`,
      };
    }

    const records = [];
    for (const e of matches.slice(0, 3)) {
      if (!/^[a-z0-9-]+$/.test(e.slug)) return couldnt('layout_changed', LIST_URL, `odd slug ${e.slug}`);
      const url = `${BASE}/companies/${e.slug}`;
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (r.status === 403 || r.status === 429) return couldnt('blocked', url, `HTTP ${r.status}`);
      if (!r.ok) return couldnt('http_error', url, `HTTP ${r.status}`);
      const rec = parseProfile(await r.text(), e.name, url);
      if (!rec) return couldnt('layout_changed', url, 'profile has no INN or OGRN');
      records.push(rec);
    }

    const first = records[0];
    return {
      status: 'found', reason: '', records,
      source_url: first.profile_url,
      excerpt: `${first.full_name}; ИНН ${first.inn}; ОГРН ${first.ogrn}; ${first.registration_date}; ${first.legal_address}`.slice(0, 500),
    };
  } catch (err) {
    return failureOf(err);
  }
}
