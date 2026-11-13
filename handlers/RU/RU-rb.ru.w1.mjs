export const meta = {
  task: 'RU-rb.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'id', 'resident_type', 'description'],
  canary: { found: 'Яндекс', not_found: 'Несуществующая Компания Ромашка' },
};

// RB.DATA company directory (rb.ru/companies/). Its "Быстрый поиск" box calls this JSON endpoint.
const API = 'https://rb.ru/data/api/residents/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed before comparing names (Russian and common foreign forms).
const LEGAL_FORMS = new Set([
  'ооо', 'оао', 'зао', 'пао', 'нао', 'ао', 'ип', 'тоо',
  'ooo', 'oao', 'zao', 'pao', 'jsc', 'pjsc', 'ojsc', 'cjsc', 'llc', 'ltd', 'limited', 'inc', 'corp',
  'corporation', 'gmbh', 'sdn', 'bhd', 'pte', 'plc', 'llp',
]);

/** Lower-case word tokens, legal form removed. "ООО «Яндекс»" -> ["яндекс"]. */
function tokens(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL_FORMS.has(t));
}

/** Normalised comparison key: no case, punctuation, spaces or legal form. */
function compact(str) {
  return tokens(str).join('');
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&laquo;|&raquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const query = tokens(keyword).join(' ');
    if (!query) return fail('other', API, 'no name left after removing the legal form');

    const params = new URLSearchParams([
      ['search', query],
      ['limit', '50'],
      ['resident_type', 'company'],
      ['company_type__activity__not', 'infrastructure'],
      ['company_type__activity__not', 'fund'],
    ]);
    searchUrl = `${API}?${params.toString()}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return fail('blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return fail('http_error', searchUrl, `HTTP ${res.status}`);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return fail(/captcha|challenge|cloudflare/i.test(text) ? 'blocked' : 'layout_changed', searchUrl, text.slice(0, 300));
    }
    if (!data || !Array.isArray(data.results) || typeof data.count !== 'number') {
      return fail('layout_changed', searchUrl, text.slice(0, 300));
    }

    const target = compact(keyword);
    const matches = data.results.filter((r) => compact(r.name) === target);

    if (matches.length === 0) {
      // Not found only when every result was read; otherwise we cannot say the company is absent.
      if (data.count > data.results.length) {
        return fail('other', searchUrl, `${data.count} results, only the first ${data.results.length} read; no exact name match`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `RB.DATA search for "${query}": ${data.count} result(s), none with this name`,
      };
    }

    const records = matches.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      resident_type: r.resident_type,
      description: cleanText(r.description).slice(0, 600),
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: (records[0].description || records[0].name).slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', searchUrl || API, String(err?.message || err));
  }
}
