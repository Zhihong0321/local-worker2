export const meta = {
  task: 'RU-fedresurs.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ogrn', 'inn', 'status', 'is_active', 'address', 'okved', 'guid'],
  canary: { found: 'ПАО СБЕРБАНК', not_found: 'ООО Несуществующая Ромашка Тест' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_LIMIT = 15;     // the site refuses larger limits (HTTP 451)
const MAX_PAGES = 4;       // at most 60 results are read
const DEADLINE_MS = 45000; // stop starting new requests after this, so the whole call ends under 60 s
const BLOCK_CODES = [401, 403, 429, 451];

// Legal-form words removed before comparing names (site writes short forms, e.g. "ПАО СБЕРБАНК").
const LEGAL_FORMS = [
  'публичное акционерное общество', 'непубличное акционерное общество', 'открытое акционерное общество',
  'закрытое акционерное общество', 'акционерное общество', 'общество с ограниченной ответственностью',
  'пао', 'оао', 'зао', 'нао', 'ао', 'ооо', 'гуп', 'муп', 'фгуп', 'ип',
];

/** Lower case, ё→е, punctuation and quotes removed, legal form removed, spaces removed. */
function nameKey(str) {
  let s = (str || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const form of LEGAL_FORMS) {
    s = (' ' + s + ' ').replace(new RegExp(' ' + form + ' ', 'g'), ' ').trim();
  }
  return s.replace(/\s+/g, '');
}

function looksBlocked(text) {
  return /qauth_show_captcha|captcha|qauth_submit/i.test(text || '');
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return list.map((c) => String(c).split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const pageUrl = `https://fedresurs.ru/search/entity?name=${encodeURIComponent(kw)}`;
  const fail = (reason, excerpt, source = pageUrl) =>
    ({ status: 'couldnt_check', reason, records: [], source_url: source, excerpt: String(excerpt).slice(0, 500) });

  try {
    if (!kw) return fail('other', 'empty company name');
    const target = nameKey(kw);
    if (!target) return fail('other', 'company name has no letters or digits');

    // Step 1: open the public search page, as a browser does, to receive the session cookie the API needs.
    const page = await fetch(pageUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    const pageHtml = await page.text();
    if (BLOCK_CODES.includes(page.status) || looksBlocked(pageHtml)) {
      return fail('blocked', `HTTP ${page.status}: bot check or captcha on the search page`);
    }
    if (!page.ok) return fail('http_error', `HTTP ${page.status} on the search page`);
    if (!pageHtml.includes('Федресурс')) return fail('layout_changed', pageHtml.slice(0, 300));
    const cookie = cookieHeader(page);
    if (!cookie) return fail('other', 'the search page set no session cookie');

    // Step 2: the company search JSON, one page at a time.
    const rows = [];
    let found = null;
    for (let page_no = 0; page_no < MAX_PAGES; page_no++) {
      if (Date.now() - started > DEADLINE_MS) return fail('timeout', 'stopped before 60 s: the search took too long');
      const offset = page_no * PAGE_LIMIT;
      const apiUrl = `https://fedresurs.ru/backend/companies?searchString=${encodeURIComponent(kw)}&limit=${PAGE_LIMIT}&offset=${offset}`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': pageUrl,
          'Cookie': cookie,
        },
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();
      if (BLOCK_CODES.includes(res.status) || looksBlocked(text)) {
        return fail('blocked', `HTTP ${res.status}: the search API refused the request`, apiUrl);
      }
      if (!res.ok) return fail('http_error', `HTTP ${res.status} from the search API`, apiUrl);

      let json;
      try { json = JSON.parse(text); } catch { return fail('layout_changed', text.slice(0, 300), apiUrl); }
      if (!json || !Array.isArray(json.pageData) || typeof json.found !== 'number') {
        return fail('layout_changed', text.slice(0, 300), apiUrl);
      }
      found = json.found;
      rows.push(...json.pageData);
      if (json.pageData.length === 0 || rows.length >= found) break;
    }

    const hits = rows.filter((r) => nameKey(r.name) === target);
    const searchSource = pageUrl;

    if (hits.length) {
      const records = hits.map((r) => ({
        name: r.name || '',
        ogrn: r.ogrn || '',
        inn: r.inn || '',
        status: r.status || '',
        is_active: r.isActive === true,
        address: r.egrulAddress || '',
        okved: r.okvedName || '',
        guid: r.guid || '',
      }));
      const summary = records.map((r) => `${r.name} | OGRN ${r.ogrn} | INN ${r.inn} | ${r.status}`).join('; ');
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchSource,
        excerpt: `${hits.length} exact name match(es) among ${found} result(s): ${summary}`.slice(0, 500),
      };
    }

    if (rows.length >= found) {
      const near = rows.slice(0, 3).map((r) => r.name).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchSource,
        excerpt: `0 exact name matches among ${found} result(s) for "${kw}"${near ? '. Nearest results: ' + near : ''}`.slice(0, 500),
      };
    }

    // The search has more results than were read and none matched exactly: the answer is not known.
    return fail('other', `no exact match in the first ${rows.length} of ${found} results for "${kw}"`, searchSource);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
