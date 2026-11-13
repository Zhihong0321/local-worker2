export const meta = {
  task: 'RU-sravni.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'short_name', 'inn', 'ogrn', 'kpp', 'opf', 'status', 'registration_date', 'liquidation_date', 'address', 'okved', 'management'],
  canary: { found: 'ПАО СБЕРБАНК', not_found: 'ООО Дезено Несуществующая Компания' },
};

const API_URL = 'https://www.sravni.ru/proxy-msb-kontragents/dadata/suggest/party';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped before comparing names (case, punctuation and legal form are ignored).
const LEGAL_WORDS = new Set([
  'ооо', 'ао', 'зао', 'оао', 'пао', 'нао', 'мкпао', 'ип', 'ано', 'тов', 'гуп', 'муп', 'фгуп', 'чуп',
  'общество', 'ограниченной', 'ответственностью', 'публичное', 'акционерное', 'открытое', 'закрытое',
  'непубличное', 'индивидуальный', 'предприниматель', 'компания',
]);

function normalize(str) {
  const words = String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_WORDS.has(w));
  return words.join('');
}

function isoDate(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalize(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API_URL,
               excerpt: 'the keyword has no company name left after removing the legal form' };
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query: String(keyword), count: 20 }),
      signal: AbortSignal.timeout(25000),
    });

    const text = await res.text();
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: API_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: API_URL, excerpt: `HTTP ${res.status}` };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const bot = /captcha|challenge|requires-javascript/i.test(text);
      return { status: 'couldnt_check', reason: bot ? 'blocked' : 'layout_changed', records: [], source_url: API_URL,
               excerpt: text.slice(0, 300) };
    }
    if (!json || !Array.isArray(json.suggestions)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: API_URL,
               excerpt: text.slice(0, 300) };
    }

    const matches = json.suggestions.filter((s) => {
      const d = s?.data || {};
      const names = [s?.value, d.name?.full_with_opf, d.name?.short_with_opf, d.name?.full, d.name?.short];
      return names.some((n) => normalize(n) === key);
    });

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: API_URL,
               excerpt: `search returned ${json.suggestions.length} entries, none with this company name` };
    }

    const records = matches.map((s) => {
      const d = s.data || {};
      return {
        name: d.name?.full_with_opf || s.value || '',
        short_name: d.name?.short_with_opf || '',
        inn: d.inn || '',
        ogrn: d.ogrn || '',
        kpp: d.kpp || '',
        opf: d.opf?.full || '',
        status: d.state?.status || '',
        registration_date: isoDate(d.state?.registration_date),
        liquidation_date: isoDate(d.state?.liquidation_date),
        address: d.address?.value || '',
        okved: d.okved || '',
        management: d.management?.name ? `${d.management.name}${d.management.post ? ', ' + d.management.post : ''}` : '',
      };
    });

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: API_URL,
      excerpt: `${first.name} | INN ${first.inn} | OGRN ${first.ogrn} | ${first.status}`.slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: API_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
