export const meta = {
  task: 'RU-basis.myseldon.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'full_name', 'inn', 'ogrn', 'kpp', 'status', 'reg_date', 'finish_date', 'address', 'okved', 'heads', 'site_id'],
  canary: { found: 'ПАО СБЕРБАНК', not_found: 'ООО Ъщфзлмкнвпрт Юбвгдж' },
};

const SEARCH_URL = 'https://basis.myseldon.com/ru/home/searchdata/';
const PAGE_URL = 'https://basis.myseldon.com/ru/home/search/?f[searchString]=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms, removed before comparing names. Longer phrases first so they are removed whole.
const LEGAL_PHRASES = [
  'публичное акционерное общество', 'открытое акционерное общество', 'закрытое акционерное общество',
  'акционерное общество', 'общество с ограниченной ответственностью', 'индивидуальный предприниматель',
  'федеральное государственное унитарное предприятие', 'государственное унитарное предприятие',
  'муниципальное унитарное предприятие', 'некоммерческая организация', 'производственный кооператив',
  'крестьянское фермерское хозяйство',
].sort((a, b) => b.length - a.length);
const LEGAL_WORDS = new Set(['ооо', 'ао', 'пао', 'зао', 'оао', 'нао', 'ип', 'нко', 'гуп', 'муп', 'фгуп', 'гбу', 'мбу', 'фбу', 'ано', 'чоп', 'опо', 'ук', 'кх', 'сп']);

/** Lower case, ё→е, punctuation and spaces removed, legal form removed. "ООО «Сбербанк»" and "Сбербанк" both give "сбербанк". */
function normalizeName(s) {
  let t = String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const p of LEGAL_PHRASES) t = (' ' + t + ' ').split(' ' + p + ' ').join(' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

function toRecord(it) {
  return {
    name: it.shortName || '',
    full_name: it.fullName || '',
    inn: String(it.inn || ''),
    ogrn: String(it.ogrn || ''),
    kpp: String(it.kpp || ''),
    status: it.statusName || '',
    reg_date: it.regdate || '',
    finish_date: it.finishdate || '',
    address: it.address || '',
    okved: [it.okved, it.okvedName].filter(Boolean).join(' '),
    heads: (Array.isArray(it.headpersons) ? it.headpersons : []).map((h) => [h.name, h.position].filter(Boolean).join(', ')),
    site_id: String(it.id ?? ''),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await search(keyword);
  } catch (err) {
    answer = fail('other', PAGE_URL, String((err && err.message) || err));
  }
  // Windows + Node 24: a process that exits right after a fetch can abort while the socket is still closing.
  // A short pause lets the connection settle before the caller ends the process.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  const kw = String(keyword || '').trim().replace(/\s+/g, ' ');
  const sourceUrl = PAGE_URL + encodeURIComponent(kw);
  if (!kw) return fail('other', sourceUrl, 'empty company name');
  try {
    // The same request the site makes when a name is typed into its search box.
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({ searchString: kw, pageIndex: '1', pageSize: '12', searchType: '0' }).toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', sourceUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', sourceUrl, `HTTP ${res.status}`);

    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      if (/captcha|challenge|recaptcha/i.test(text)) return fail('blocked', sourceUrl, 'bot check page');
      return fail('layout_changed', sourceUrl, text.slice(0, 200));
    }
    if (!j || j.result !== 200 || !j.response || typeof j.response !== 'object') {
      if (j && (j.result === 401 || j.result === 403)) return fail('blocked', sourceUrl, `site result ${j.result}`);
      return fail('other', sourceUrl, `site result ${j && j.result}: ${String(j && (j.error || j.message) || '').slice(0, 200)}`);
    }

    const resp = j.response;
    const items = Array.isArray(resp.items) ? resp.items : [];
    const count = Number(resp.count) || 0;
    const want = normalizeName(kw);
    if (!want) return fail('other', sourceUrl, 'no name left after removing punctuation and legal form');

    const matches = items.filter((it) => normalizeName(it.shortName) === want || normalizeName(it.fullName) === want);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: sourceUrl,
        excerpt: `${matches.length} match(es) among ${count} site results: ${matches.map((m) => m.shortName).join('; ')}`.slice(0, 500),
      };
    }

    // No normalised match. The site answered normally: either it lists nothing, every listed result is shown,
    // or it has corrected the query to something else (no exact match). Only a long list it did not fully show
    // is left unresolved.
    if (count === 0 || items.length >= count || resp.iscorrected === true) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `0 matching names among ${count} site results${resp.iscorrected === true ? ' (site corrected the query)' : ''}`,
      };
    }
    return fail('other', sourceUrl, `${count} site results, none with this exact name among the first ${items.length}`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', sourceUrl, String((err && err.message) || err));
  }
}
