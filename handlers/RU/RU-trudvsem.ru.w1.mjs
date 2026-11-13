export const meta = {
  task: 'RU-trudvsem.ru',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'inn', 'ogrn', 'url', 'region', 'vacancies_seen'],
  canary: { found: 'ООО "САБАЙ ТЮМЕНЬ"', not_found: 'ООО "ФАНТОМНАЯ КОМПАНИЯ НЕСУЩЕСТВУЮЩАЯ"' },
};

const API = 'https://opendata.trudvsem.ru/api/v1/vacancies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed when comparing names (Russian and common Latin forms).
const LEGAL_FORMS = new Set([
  'ооо', 'оао', 'зао', 'ао', 'пао', 'нао', 'ип', 'гуп', 'муп', 'фгуп', 'фгбу', 'фгку', 'фгау', 'гбу', 'гау', 'гку',
  'мбу', 'мау', 'мку', 'гбоу', 'мбоу', 'ано', 'нко', 'тсж', 'llc', 'ltd', 'jsc', 'cjsc', 'pjsc',
]);

/** Lowercase, ё→е, quotes and punctuation to spaces, single spaces. Keeps legal-form words. */
function cleanName(str) {
  return (str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'“”„`´.,;:()\[\]\-–—_\/\\!?&+*#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Name without legal form, for comparison. */
function stripForm(str) {
  return cleanName(str).split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

function errorAnswer(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** One call to the public vacancy API, text search. Returns {ok,data} or {answer} with the couldnt_check to return. */
async function search(text, url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { answer: errorAnswer(timedOut ? 'timeout' : 'other', url, 'request failed: ' + (err?.message || err)) };
  }
  if (res.status === 403 || res.status === 429) {
    return { answer: errorAnswer('blocked', url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { answer: errorAnswer('http_error', url, `HTTP ${res.status}`) };
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch (err) {
    return { answer: errorAnswer('layout_changed', url, 'response is not JSON') };
  }
  if (!data || typeof data !== 'object' || !data.meta || !('results' in data)) {
    return { answer: errorAnswer('layout_changed', url, 'JSON has no meta/results: ' + JSON.stringify(data).slice(0, 200)) };
  }
  const vacancies = (data.results && Array.isArray(data.results.vacancies)) ? data.results.vacancies : [];
  return { data: { total: Number(data.meta.total) || 0, vacancies } };
}

/** Companies named in the result rows that match the keyword. */
function matchCompanies(vacancies, keyword) {
  const fullKw = cleanName(keyword);
  const strippedKw = stripForm(keyword);
  const exact = new Map();
  const stripped = new Map();
  for (const row of vacancies) {
    const v = row && row.vacancy;
    const c = v && v.company;
    if (!c || !c.name) continue;
    const key = `${c.name}|${c.inn || ''}|${c.ogrn || ''}`;
    const entry = exact.get(key) || stripped.get(key);
    const record = entry || {
      name: c.name,
      inn: c.inn || '',
      ogrn: c.ogrn || '',
      url: c.url || '',
      region: (v.region && v.region.name) || '',
      vacancies_seen: 0,
    };
    record.vacancies_seen += 1;
    if (cleanName(c.name) === fullKw) exact.set(key, record);
    else if (stripForm(c.name) === strippedKw && strippedKw) stripped.set(key, record);
  }
  // Same legal form written out: prefer those. Otherwise the same name with another legal form.
  const pick = exact.size ? exact : stripped;
  return [...pick.values()];
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the HTTP socket close before the caller ends the process (Node 24 on Windows asserts otherwise).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!input) return errorAnswer('other', API, 'empty company name');

    // Search text: the name without quotes, punctuation and legal form. The site search matches words.
    const words = stripForm(input).split(' ').filter(Boolean);
    if (!words.length) return errorAnswer('other', API, 'no searchable words in the name');
    const searchText = words.join(' ');

    const url1 = `${API}?${new URLSearchParams({ text: searchText, limit: '100' }).toString()}`;
    const first = await search(searchText, url1);
    if (first.answer) return first.answer;

    let { total, vacancies } = first.data;
    let usedUrl = url1;
    let matches = matchCompanies(vacancies, input);

    // Nothing at all for the full name: try the longest word once (the site search is word based).
    if (!matches.length && total === 0 && words.length > 1) {
      const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
      const url2 = `${API}?${new URLSearchParams({ text: longest, limit: '100' }).toString()}`;
      const second = await search(longest, url2);
      if (second.answer) return second.answer;
      total = second.data.total;
      vacancies = second.data.vacancies;
      usedUrl = url2;
      matches = matchCompanies(vacancies, input);
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: usedUrl,
        excerpt: `${matches.length} company record(s) with this name; ${matches[0].name}, INN ${matches[0].inn}, OGRN ${matches[0].ogrn}`,
      };
    }

    // No match. Only "not found" when every matching vacancy was in the answer.
    if (total > vacancies.length) {
      return errorAnswer('other', usedUrl, `search returned ${total} vacancies, only the first ${vacancies.length} were checked`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: usedUrl,
      excerpt: `No company named "${input}" among the ${total} vacancies matching "${searchText}" on trudvsem.ru (companies are listed through their vacancies)`,
    };
  } catch (err) {
    return errorAnswer('other', API, err?.message || err);
  }
}
