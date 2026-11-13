export const meta = { task: 'RU-yandex.ru', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['name', 'short_name', 'address', 'chain', 'categories', 'status', 'org_id', 'rating', 'review_count', 'inn', 'ogrn', 'total_results'],
  canary: { found: 'Яндекс', not_found: 'Несуществующая Фирма Ромашка Квадрат 98765' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Centre of Russia, zoom 2: the search is not limited to the visitor's IP region (a small view returns almost nothing).
const VIEW = '&ll=105.0,62.0&z=2';
const LEGAL_PHRASES = ['общество с ограниченной ответственностью', 'публичное акционерное общество',
  'открытое акционерное общество', 'закрытое акционерное общество', 'акционерное общество', 'индивидуальный предприниматель'];
const LEGAL_WORDS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип', 'нко', 'llc', 'ltd', 'jsc']);

/** Lower case, ё→е, quotes and punctuation removed, legal form removed. */
function core(str) {
  let s = (str || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const p of LEGAL_PHRASES) s = s.replace(new RegExp(`(^| )${p}( |$)`, 'g'), ' ');
  return s.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

function featureValue(features, name) {
  const f = (features || []).find((x) => x && (x.name === name || x.id === name));
  if (!f) return '';
  const v = Array.isArray(f.value) ? f.value.map((x) => (x && (x.name || x.value)) || x).join(', ') : f.value;
  return v == null ? '' : String(v);
}

/** An organisation matches when its name (or its brand, without a branch suffix) is the company name. */
function matches(item, kw) {
  const title = core(item.title);
  if (title === kw || core(item.shortTitle) === kw) return true;
  const chainCore = core(String((item.chain && item.chain.name) || '').split(',')[0]);
  const titleWords = title.split(' ').filter(Boolean);
  const kwWords = new Set(kw.split(' '));
  // Chain match only when the item's own name is no longer than the company name ("Сбербанк" under "Сбербанк России").
  return chainCore === kw && titleWords.length > 0 && titleWords.every((w) => kwWords.has(w));
}

function findSearchResults(state) {
  const entry = (state.stack || []).find((s) => s && s.results && Array.isArray(s.results.items) && s.request && s.request.searchType === 'TEXT');
  return entry ? entry.results : null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const kw = core(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    searchUrl = `https://yandex.ru/maps/?text=${encodeURIComponent(kw)}${VIEW}`;
    const res = await fetch(searchUrl, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    const finalUrl = res.url || searchUrl;

    if (res.status === 403 || res.status === 429 || /captcha/i.test(finalUrl)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status} ${finalUrl}`.slice(0, 300) };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const m = html.match(/<script type="application\/json" class="state-view">([\s\S]*?)<\/script>/);
    if (!m) {
      const blocked = /showcaptcha|SmartCaptcha|Вы не робот/i.test(html);
      return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url: searchUrl,
        excerpt: (blocked ? 'captcha page' : 'no search data in page').slice(0, 300) };
    }

    let state;
    try { state = JSON.parse(m[1]); } catch (e) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: 'search data is not JSON' };
    }
    const results = findSearchResults(state);
    if (!results) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: 'no search results block in page data' };
    }

    const items = results.items;
    const total = Number(results.totalResultCount) || items.length;
    const hits = items.filter((it) => matches(it, kw));

    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${total} results from Yandex Maps, none with the name "${keyword}"` };
    }

    const records = hits.map((it) => ({
      name: it.title || '',
      short_name: it.shortTitle || '',
      address: it.fullAddress || it.address || '',
      chain: (it.chain && it.chain.name) || '',
      categories: (it.categories || []).map((c) => c.name).filter(Boolean),
      status: it.status || '',
      org_id: it.id || '',
      rating: it.ratingData ? it.ratingData.ratingValue : null,
      review_count: it.ratingData ? it.ratingData.reviewCount : null,
      inn: featureValue(it.features, 'ИНН'),
      ogrn: featureValue(it.features, 'ОГРН'),
      total_results: total,
    }));

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${hits.length} of ${total} Yandex Maps results match "${keyword}": ${first.name}, ${first.address}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
