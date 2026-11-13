export const meta = {
  task: 'RU-rutube.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'channel_id', 'is_official', 'video_count', 'subscribers_count', 'description', 'channel_url'],
  canary: { found: 'Газпром', not_found: 'Несуществующая Компания Тест' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://rutube.ru/api/search/combined/cards/list';
const SEARCH_PAGE = 'https://rutube.ru/search/?query=';
const MAX_PAGES = 10;
const DEADLINE_MS = 45000;

// Legal-form words that are removed before comparing names (Russian and common Latin forms).
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип', 'гуп', 'муп', 'фгуп', 'ано', 'нко',
  'llc', 'ltd', 'jsc', 'pjsc', 'inc', 'corp', 'plc']);

function words(str) {
  return (str || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The name as sent to the site's search: words only, legal form removed, original spelling kept. */
function queryText(str) {
  return words(str).filter((w) => !LEGAL_FORMS.has(w.toLowerCase())).join(' ');
}

/** Normalised key for exact comparison: lower case, ё = е, punctuation and legal form removed, no spaces. */
function matchKey(str) {
  return words(str)
    .map((w) => w.toLowerCase().replace(/ё/g, 'е'))
    .filter((w) => !LEGAL_FORMS.has(w))
    .join('');
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await runLookup(keyword);
  // Let the fetch sockets close before the worker exits: on Windows an immediate exit after a fetch
  // can abort the process with a libuv assertion (exit 127) even though the answer was already printed.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}

async function runLookup(keyword) {
  const started = Date.now();
  let q = '';
  let pageUrl = '';
  const records = [];
  try {
    q = queryText(keyword);
    const key = matchKey(keyword);
    pageUrl = SEARCH_PAGE + encodeURIComponent(q);
    if (!key) return fail('couldnt_check', 'other', pageUrl, 'no company name left after removing the legal form');

    let page = 1;
    let hasNext = true;
    let scanned = 0;
    while (hasNext) {
      // Once some records are found, a later failure does not hide them: the match is still valid evidence.
      const bail = (status, reason, excerpt) =>
        records.length ? found(records, pageUrl, keyword) : fail(status, reason, pageUrl, excerpt);

      if (page > MAX_PAGES) return bail('couldnt_check', 'other', `search has more pages than the ${MAX_PAGES} checked`);
      if (Date.now() - started > DEADLINE_MS) return bail('couldnt_check', 'timeout', 'search did not finish within 45 s');

      const apiUrl = `${API}?query=${encodeURIComponent(q)}&page=${page}&per_page=20&fields=video_count%2Cis_official&content_type=channel`;
      let res;
      try {
        res = await fetch(apiUrl, {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
          },
          signal: AbortSignal.timeout(25000),
        });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return bail('couldnt_check', timedOut ? 'timeout' : 'other', String(e?.message || e));
      }

      if (res.status === 403 || res.status === 429) return bail('couldnt_check', 'blocked', `HTTP ${res.status}`);
      if (!res.ok) return bail('couldnt_check', 'http_error', `HTTP ${res.status}`);

      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || !Array.isArray(data.results)) {
        if (/captcha|challenge|access denied|доступ ограничен/i.test(text.slice(0, 5000))) {
          return bail('couldnt_check', 'blocked', text.slice(0, 200));
        }
        return bail('couldnt_check', 'layout_changed', text.slice(0, 200));
      }

      for (const r of data.results) {
        scanned += 1;
        if (matchKey(r.name) === key) {
          records.push({
            name: r.name,
            channel_id: r.id,
            is_official: r.is_official === true,
            video_count: r.video_count ?? null,
            subscribers_count: r.subscribers_count ?? null,
            description: String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            channel_url: `https://rutube.ru/channel/${r.id}/`,
          });
        }
      }

      hasNext = data.has_next === true && data.results.length > 0;
      page += 1;
    }

    if (records.length) return found(records, pageUrl, keyword);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `0 Rutube channels named "${q}" (${scanned} search results checked)`,
    };
  } catch (err) {
    if (records.length) return found(records, pageUrl, keyword);
    return fail('couldnt_check', 'other', pageUrl, String(err?.message || err));
  }
}

function found(records, source_url, keyword) {
  const first = records[0];
  return {
    status: 'found',
    reason: '',
    records,
    source_url,
    excerpt: `${records.length} Rutube channel(s) named "${keyword}": ${first.name}, ${first.is_official ? 'official' : 'not marked official'}, ${first.subscribers_count ?? '?'} subscribers`,
  };
}
