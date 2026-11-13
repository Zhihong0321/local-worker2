export const meta = { task: 'RU-rusprofile.ru', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'inn', 'ogrn', 'status', 'address', 'region', 'ceo_name', 'ceo_type', 'reg_date', 'okved', 'authorized_capital', 'url'],
  canary: { found: 'ПАО Сбербанк', not_found: 'ООО Ромашка Фантом Несуществующая' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.rusprofile.ru';

// Russian legal-form words that the site and the user may put in front of or after a name.
const LEGAL_FORMS = new Set(['пао', 'оао', 'зао', 'ао', 'нао', 'ооо', 'ип', 'нко', 'гуп', 'муп', 'фгуп', 'тоо', 'чоп', 'пк']);

/** Compare names: case, ё/е, quotes, punctuation and legal form do not count. */
function normName(s) {
  const words = String(s || '').replace(/!~~|~~!/g, '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL_FORMS.has(w));
  return words.join('');
}

/** The site wraps the matched words in !~~ ~~! markers; remove them. */
function clean(s) {
  return String(s ?? '').replace(/!~~|~~!/g, '').replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/ajax.php?action=search&query=${encodeURIComponent(String(keyword || '').trim())}`;
  try {
    const kwNorm = normName(keyword);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'keyword has no name part' };
    }

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ru,en;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|Just a moment/i.test(text.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: text.slice(0, 200) };
    }
    let data;
    try { data = JSON.parse(text); } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    // The site leaves out "ul" when there are no legal entity results, so an empty list is a normal answer.
    const list = Array.isArray(data?.ul) ? data.ul : [];
    if (!data || data.success !== true || typeof data.ul_count !== 'number' || (data.ul_count > 0 && list.length === 0)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: JSON.stringify(data).slice(0, 300) };
    }

    const matches = list.filter((row) => normName(row.raw_name || row.name) === kwNorm);
    if (matches.length > 0) {
      const records = matches.map((row) => ({
        name: clean(row.raw_name || row.name),
        inn: clean(row.inn),
        ogrn: clean(row.ogrn),
        status: row.inactive === 1 ? 'inactive' : 'active',
        address: clean(row.address),
        region: clean(row.region),
        ceo_name: clean(row.ceo_name),
        ceo_type: clean(row.ceo_type),
        reg_date: clean(row.reg_date),
        okved: clean(`${row.main_okved_id || ''} ${row.okved_descr || ''}`),
        authorized_capital: clean(row.authorized_capital),
        url: row.link ? new URL(row.link, BASE).href : '',
      }));
      const first = records[0];
      return { status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${first.name} | INN ${first.inn} | OGRN ${first.ogrn} | ${first.status} | ${first.address}`.slice(0, 500) };
    }

    // No exact match. Only "not_found" when the site showed every result it has for this search.
    const shownNames = list.map((row) => clean(row.raw_name || row.name)).join('; ');
    const otherRecords = Number(data.ip_count || 0) + Number(data.fl_count || 0);
    if (list.length < data.ul_count || otherRecords > 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: `search shows ${data.ul_count} legal entities, ${list.length} returned, no exact name match; ` +
          `sole proprietor/person hits ${otherRecords}; shown: ${shownNames}`.slice(0, 500) };
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `search returned ${data.ul_count} legal entities, none named like "${keyword}"` + (shownNames ? `; shown: ${shownNames}` : '') };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
