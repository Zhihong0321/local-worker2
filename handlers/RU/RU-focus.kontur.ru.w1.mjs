export const meta = {
  task: 'RU-focus.kontur.ru',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'inn', 'ogrn', 'reg_date', 'address', 'activity', 'site_id'],
  canary: { found: 'АО "ПФ "СКБ Контур"', not_found: 'Дезено Несуществующая Компания' },
};

// Kontur.Focus public search: the JSON endpoint that the anonymous search page calls. No login, no token.
const BASE = 'https://focus.kontur.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;          // the site returns 10 results per page
const MAX_PAGES = 5;           // read at most 5 pages; a miss beyond that cannot be called not_found
const START_LIMIT_MS = 30000;  // do not start another page after 30 s (each fetch has a 25 s timeout, so the call stays under 60 s)

const ENTITIES = { '&quot;': '"', '&laquo;': '«', '&raquo;': '»', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&nbsp;': ' ' };
const BLOCK_RE = /captcha|капча|robot|are you human|доступ ограничен|access denied|forbidden/i;

// Legal forms, removed from the start and end of a name before comparing.
const FORMS = [
  'общество с ограниченной ответственностью', 'публичное акционерное общество', 'непубличное акционерное общество',
  'закрытое акционерное общество', 'открытое акционерное общество', 'акционерное общество',
  'индивидуальный предприниматель', 'ооо', 'ао', 'зао', 'пао', 'оао', 'ип', 'нко', 'фгуп', 'гуп', 'муп', 'тоо',
];

function clean(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised name for comparison: case, ё, quotes, punctuation and legal form are removed. */
function coreName(name) {
  let s = clean(name).toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"“”„'`’‘()\[\].,;:!?\-–—_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of FORMS) {
      if (s.startsWith(f + ' ')) { s = s.slice(f.length + 1).trim(); changed = true; }
      else if (s.endsWith(' ' + f)) { s = s.slice(0, -(f.length + 1)).trim(); changed = true; }
    }
  }
  return s;
}

function searchUrl(keyword, page) {
  return `${BASE}/v2/api/search?query=${encodeURIComponent(keyword)}&country=RU` + (page > 1 ? `&page=${page}` : '');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function toRecord(d) {
  const req = {};
  for (const r of d.requisites || []) req[r.key] = r.value;
  const text = (type) => {
    const f = (d.fields || []).find((x) => x && x.type === type);
    return f && f.content ? clean(f.content.text) : '';
  };
  return {
    name: clean(d.rawName || d.name),
    inn: req['ИНН'] || '',
    ogrn: req['ОГРН'] || '',
    reg_date: d.regDate || '',
    address: text('address'),
    activity: text('plain'),
    site_id: String(d.id || ''),
  };
}

/** One search page. Returns { json, url } or { fail }. */
async function getPage(keyword, page) {
  const url = searchUrl(keyword, page);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ru,en;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status}`) };
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!json || typeof json !== 'object' || !Array.isArray(json.data) || typeof json.hits !== 'number') {
    if (BLOCK_RE.test(text)) return { fail: fail('blocked', url, 'access or bot check page instead of results') };
    return { fail: fail('layout_changed', url, text.slice(0, 200)) };
  }
  return { json, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await lookupOnce(keyword);
  } catch (err) {
    answer = fail('other', '', err && err.message ? err.message : err);
  }
  // Let the keep-alive sockets close before the worker exits: on Windows, Node 24 asserts (exit 127)
  // when the process exits while a fetch connection is still closing. Costs 0.5 s, changes no answer.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const t0 = Date.now();
  const kw = clean(keyword);
  const want = coreName(kw);
  if (!want) return fail('other', searchUrl(kw, 1), 'empty company name');

  const records = [];
  let lastUrl = searchUrl(kw, 1);
  let page = 1;
  let pagesRead = 0;
  let totalPages = 1;
  let hits = 0;

  try {
    for (;;) {
      if (page > 1 && Date.now() - t0 > START_LIMIT_MS) {
        if (records.length) break;
        return fail('timeout', lastUrl, `read ${pagesRead} of ${totalPages} result pages before the 60 s limit`);
      }
      const r = await getPage(kw, page);
      if (r.fail) {
        if (records.length) break; // a match is already proven; keep it
        return r.fail;
      }
      const j = r.json;
      lastUrl = r.url;
      pagesRead = page;
      hits = j.hits;
      totalPages = Math.max(1, Math.ceil(j.hits / PAGE_SIZE));
      for (const d of j.data) {
        if (d && coreName(d.rawName || d.name) === want) records.push(toRecord(d));
      }
      if (page >= Math.min(totalPages, MAX_PAGES)) break;
      page += 1;
    }
  } catch (err) {
    if (!records.length) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return fail(timedOut ? 'timeout' : 'other', lastUrl, err && err.message ? err.message : err);
    }
  }

  if (records.length) {
    return {
      status: 'found',
      reason: '',
      records,
      source_url: lastUrl,
      excerpt: `${records.length} match(es) for "${kw}" on the Kontur.Focus search; read ${pagesRead} of ${totalPages} result pages`,
    };
  }
  if (pagesRead < totalPages) {
    return fail('other', lastUrl, `no match on the ${pagesRead} result pages read; ${totalPages} pages exist, the rest were not read`);
  }
  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl,
    excerpt: `search returned ${hits} result(s), none with this company name`,
  };
}
