export const meta = {
  task: 'RU-habr.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'alias', 'id', 'profile_url', 'subscribers_count'],
  canary: { found: '#Инфомания', not_found: 'Ромашка Несуществующая' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://habr.com/kek/v2/companies/search/';
const MAX_PAGES = 10;
const DEADLINE_MS = 50000;
const LEGAL_FORMS = new Set(['ооо', 'зао', 'оао', 'пао', 'ао', 'нао', 'ип', 'llc', 'ltd', 'jsc', 'pjsc', 'ojsc', 'cjsc', 'inc', 'corp']);

/** Name split into words, with the legal form removed from both ends (case, quotes, punctuation ignored). */
function tokens(s) {
  const t = String(s || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (t.length && LEGAL_FORMS.has(t[0])) t.shift();
  while (t.length && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

function decode(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/gi, '/')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const toks = tokens(keyword);
  const key = toks.join('');
  const query = toks.join(' ');
  const pageUrl = (page) => `${API}?q=${encodeURIComponent(query)}&page=${page}`;
  let lastUrl = pageUrl(1);

  if (!key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl, excerpt: 'no name left after removing the legal form' };
  }

  try {
    const matches = [];
    const seenTitles = [];
    let pagesCount = 1;

    for (let page = 1; page <= pagesCount; page++) {
      if (page > MAX_PAGES) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl,
          excerpt: `${pagesCount} result pages for "${query}"; only the first ${MAX_PAGES} were checked` };
      }
      if (Date.now() - started > DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: lastUrl, excerpt: 'search pages did not finish in time' };
      }

      lastUrl = pageUrl(page);
      const res = await fetch(lastUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://habr.com/ru/search/',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: lastUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: lastUrl, excerpt: `HTTP ${res.status}` };
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const reason = /captcha|challenge|access denied/i.test(text.slice(0, 3000)) ? 'blocked' : 'layout_changed';
        return { status: 'couldnt_check', reason, records: [], source_url: lastUrl, excerpt: text.slice(0, 300) };
      }
      if (!data || !Array.isArray(data.companyIds) || !data.companyRefs || typeof data.companyRefs !== 'object') {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: lastUrl, excerpt: text.slice(0, 300) };
      }

      pagesCount = Number(data.pagesCount) || 1;
      for (const id of data.companyIds) {
        const ref = data.companyRefs[id];
        if (!ref) continue;
        const title = decode(ref.titleHtml);
        seenTitles.push(title);
        if (tokens(title).join('') === key) {
          matches.push({
            name: title,
            alias: String(ref.alias || ''),
            id: String(ref.id || ''),
            profile_url: `https://habr.com/ru/companies/${encodeURIComponent(String(ref.alias || ''))}/profile/`,
            subscribers_count: ref.statistics?.subscribersCount ?? null,
          });
        }
      }
      if (matches.length) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: lastUrl,
        excerpt: matches.map((m) => `${m.name} (alias ${m.alias}, ${m.subscribers_count} subscribers)`).join('; ').slice(0, 500),
      };
    }

    const similar = seenTitles.slice(0, 5).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `No company with this exact name on Habr (${seenTitles.length} search result(s) checked)` +
        (similar ? `. Similar names: ${similar}` : ''),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
