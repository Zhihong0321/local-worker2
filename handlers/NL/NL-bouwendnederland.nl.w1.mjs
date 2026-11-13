export const meta = {
  task: 'NL-bouwendnederland.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'province', 'region'],
  canary: { found: 'Van Wijnen Amsterdam B.V.', not_found: 'Zzqxw Onbekend B.V.' },
};

// Public member directory ("Lidbedrijven", /vereniging/lidbedrijven). The page calls this JSON endpoint with
// search=<text>; it is the same call the page makes for anonymous visitors (organisations-public, no login).
const API = 'https://www.bouwendnederland.nl/api/azure/organisations-public.get';
const DIRECTORY_PAGE = 'https://www.bouwendnederland.nl/vereniging/lidbedrijven';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 30;
const MAX_PAGES = 6;          // 180 search hits at most; beyond that the answer is couldnt_check, not not_found
const BUDGET_MS = 50000;      // whole call stays under 60 s

// Legal-form endings, as folded token sequences (lower case, no punctuation).
const LEGAL_FORMS = [
  ['besloten', 'vennootschap', 'met', 'beperkte', 'aansprakelijkheid'],
  ['besloten', 'vennootschap'],
  ['naamloze', 'vennootschap'],
  ['commanditaire', 'vennootschap'],
  ['eenmanszaak'], ['maatschap'], ['bv'], ['nv'], ['vof'], ['cv'], ['bvba'], ['gmbh'], ['ltd'], ['limited'], ['llc'],
  ['b', 'v'], ['n', 'v'], ['v', 'o', 'f'], ['c', 'v'],
];

/** Lower case, no accents, '&' as 'en', punctuation to spaces. */
function fold(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Folded name with the trailing legal form removed, so "Acme B.V." and "ACME" compare equal. */
function baseName(s) {
  let tokens = fold(s).split(' ').filter(Boolean);
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    for (const form of LEGAL_FORMS) {
      if (tokens.length > form.length && form.every((t, i) => tokens[tokens.length - form.length + i] === t)) {
        tokens = tokens.slice(0, tokens.length - form.length);
        changed = true;
        break;
      }
    }
  }
  return tokens.join(' ');
}

function searchUrl(query, page) {
  const u = new URL(API);
  u.searchParams.set('page', String(page));
  u.searchParams.set('pageSize', String(PAGE_SIZE));
  u.searchParams.set('search', query);
  return u.href;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!input) return fail('other', DIRECTORY_PAGE, 'empty company name');

    const target = baseName(input) || fold(input);
    const query = target;                       // search on the name without the legal form: wider candidate set
    const firstUrl = searchUrl(query, 1);
    const deadline = Date.now() + BUDGET_MS;

    const matches = [];
    let page = 1;
    let totalPages = 1;
    let totalCount = null;

    do {
      const remaining = deadline - Date.now();
      if (remaining < 2000) break;

      let res;
      try {
        res = await fetch(searchUrl(query, page), {
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
          },
          signal: AbortSignal.timeout(Math.min(25000, remaining)),
        });
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return fail('timeout', firstUrl, 'no answer from the directory in time');
        return fail('other', firstUrl, 'request failed: ' + (e?.message || e));
      }

      if (res.status === 403 || res.status === 429) return fail('blocked', firstUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', firstUrl, `HTTP ${res.status}`);

      let data;
      try {
        data = await res.json();
      } catch {
        return fail('layout_changed', firstUrl, 'answer is not JSON');
      }
      if (!data || !Array.isArray(data.items) || typeof data.totalCount !== 'number') {
        return fail('layout_changed', firstUrl, 'JSON has no items/totalCount: ' + JSON.stringify(data).slice(0, 200));
      }

      totalCount = data.totalCount;
      totalPages = Number(data.totalPages) || 0;

      for (const it of data.items) {
        if (it && typeof it.name === 'string' && baseName(it.name) === target) {
          matches.push({
            name: it.name,
            city: it.city ?? '',
            province: it.province ?? '',
            region: it.region ?? '',
          });
        }
      }
      page += 1;
    } while (page <= totalPages && page <= MAX_PAGES);

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${matches.length} listed member(s) matching "${input}": ${matches.map(m => m.name).join('; ')}`.slice(0, 500),
      };
    }

    const allRead = page > totalPages;
    if (totalCount === null) return fail('timeout', firstUrl, 'time budget used before the first page');
    if (!allRead) {
      return fail('other', firstUrl, `search returned ${totalCount} hits; only the first ${MAX_PAGES} pages or the time budget were read, no exact match`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 member names match "${input}" (search "${query}" returned ${totalCount} hits, none with the same name)`,
    };
  } catch (err) {
    return fail('other', DIRECTORY_PAGE, String(err?.message || err));
  }
}
