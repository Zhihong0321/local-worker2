export const meta = {
  task: 'RU-retail.ru',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'name_en', 'legal_form', 'country', 'address', 'inn', 'url'],
  canary: { found: 'Керапром', not_found: 'Дезено' },
};

const BASE = 'https://retail.ru';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

// Legal forms, removed when comparing names (ООО Керапром = Керапром).
const LEGAL = new Set(['ооо', 'оао', 'зао', 'ао', 'пао', 'нао', 'ип', 'тоо', 'нко', 'llc', 'ltd', 'llp', 'inc', 'gmbh', 'sdn', 'bhd', 'jsc', 'pjsc', 'plc', 'corp']);

function words(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Comparison key: case, punctuation, quotes and legal form ignored. */
function normalizeName(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join('');
}

/** The name the site search is given: quotes and legal form removed. */
function coreName(s) {
  const kept = String(s || '').replace(/[«»"'“”„]/g, ' ').split(/\s+/)
    .filter((t) => t && !LEGAL.has(words(t).join('')));
  return kept.join(' ') || String(s || '').trim();
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function textOf(html) {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"', 'i'));
  return m ? decodeHtml(m[1]) : '';
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const searchUrl = `${BASE}/search/?q=${encodeURIComponent(coreName(input))}`;
  try {
    if (!input) return fail('other', searchUrl, 'empty company name');
    const want = normalizeName(input);
    if (!want) return fail('other', searchUrl, 'no name left after removing the legal form');

    // Step 1: the site search (server-rendered HTML).
    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);
    const html = await res.text();

    if (!html.includes('Результаты поиска')) {
      if (/captcha|cf-chl|Attention Required|Проверка безопасности/i.test(html)) {
        return fail('blocked', searchUrl, 'captcha or bot check page');
      }
      return fail('layout_changed', searchUrl, html.replace(/\s+/g, ' ').slice(0, 300));
    }

    // Company links in the results: href /rbc/company/<slug>/ with the company name as title.
    const matches = [];
    const seen = new Set();
    for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
      const href = attr(tag, 'href');
      const title = attr(tag, 'title');
      if (!href || !title || normalizeName(title) !== want) continue;
      let path;
      try { path = new URL(href, BASE).pathname; } catch { continue; }
      const m = path.match(/^\/rbc\/company\/([^/]+)\/$/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      matches.push({ title, url: new URL(path, BASE).href });
    }

    if (matches.length === 0) {
      const zero = html.includes('ничего не найдено');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: zero ? 'search: ничего не найдено' : 'search results contain no company with this name',
      };
    }

    // Step 2: the company page, for the registry-style fields (legal name, INN, address).
    const first = matches[0];
    let detail = null;
    let detailNote = '';
    try {
      const dr = await fetch(first.url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (dr.ok) detail = await dr.text();
      else detailNote = `company page HTTP ${dr.status}`;
    } catch (e) {
      detailNote = `company page: ${String(e?.message || e).slice(0, 120)}`;
    }

    const records = [];
    if (detail) {
      // Match the element's class attribute, not the CSS text that also contains these class names.
      const h1 = textOf((detail.match(/<h1[^>]*class="[^"]*view__name-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
      const legal = textOf((detail.match(/class="[^"]*view__name-yur[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1])
        .replace(/\s*\(юр\. название\)\s*$/i, '');
      const eng = textOf((detail.match(/class="[^"]*view__name-eng[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1])
        .replace(/\s*\(англ\.\)\s*$/i, '');
      let legalForm = '', country = '', address = '', inn = '';
      if (legal) {
        const esc = legal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // The page carries a serialized data block: "legal name","address","legal form",[ids],"country",...,"INN".
        // The block may come with escaped quotes (\"), and extra positional values appear between the fields,
        // so an optional backslash is allowed before each quote and the gaps are short and lazy.
        const Q = '\\\\?"';
        const gap = '[^\\n]{0,40}?';
        const pat = Q + esc + Q + ',' + Q + '([^"\\\\]*)' + Q + gap + Q + '([^"\\\\]*)' + Q + gap +
          Q + '([^"\\\\]*)' + Q + gap + Q + '(\\d{10}|\\d{12})' + Q;
        const m = detail.match(new RegExp(pat));
        if (m) { address = m[1]; legalForm = m[2]; country = m[3]; inn = m[4]; }
      }
      records.push({
        name: h1 || first.title,
        legal_name: legal,
        name_en: eng,
        legal_form: legalForm,
        country,
        address,
        inn,
        url: first.url,
      });
    } else {
      records.push({ name: first.title, url: first.url });
    }
    for (const extra of matches.slice(1)) {
      records.push({ name: extra.title, url: extra.url });
    }

    const r0 = records[0];
    const excerpt = [r0.name, r0.legal_name, r0.address, detailNote].filter(Boolean).join(' | ');
    return { status: 'found', reason: '', records, source_url: first.url, excerpt: excerpt.slice(0, 300) };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
