export const meta = {
  task: 'CH-faovd.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_form', 'seat', 'che_number', 'notice_category', 'notice_date', 'match', 'notice_text'],
  canary: { found: 'Stockalper Partners SA', not_found: 'Zzqxvbnm SA' },
};

const HOME = 'https://faovd.ch/';
const SEARCH = 'https://faovd.ch/recherche';
const LISTING = 'https://faovd.ch/registre-commerce/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['sa', 'sarl', 'ag', 'gmbh', 'sagl', 'kg', 'slu']);
const BUDGET_MS = 50000; // the whole lookup must finish under 60 s

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&apos;|&#039;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case, no accents, punctuation removed, legal forms written one way (SA, S.A., Sàrl, S.à r.l. ...). */
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\bsocietes? anonymes?\b/g, 'sa')
    .replace(/\bsocietes? a responsabilite limitee\b/g, 'sarl')
    .replace(/\bs a r l\b/g, 'sarl')
    .replace(/\bs a\b/g, 'sa');
}

/** A company name split into its base name and legal form. The site adds "en liquidation" and ", succursale de ..." to names. */
function canon(raw) {
  let s = String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\s+(en liquidation|en faillite|in liquidation)\b.*$/, '').replace(/,.*$/, '');
  const tokens = norm(s).split(' ').filter(Boolean);
  const form = LEGAL_FORMS.has(tokens[tokens.length - 1]) ? tokens[tokens.length - 1] : '';
  const base = (form ? tokens.slice(0, -1) : tokens).join(' ');
  return { full: tokens.join(' '), base, form };
}

function sameCompany(kw, name) {
  const n = canon(name);
  if (!kw.base || n.base !== kw.base) return false;
  return !kw.form || !n.form || kw.form === n.form;
}

/** Split a results or listing page into notices. */
function parseArticles(html) {
  return String(html).split(/<article\b/i).slice(1).map((chunk) => {
    const body = chunk.split(/<\/article>/i)[0].replace(/^[^>]*>/, '');
    const names = [...body.matchAll(/<span class="b">([\s\S]*?)<\/span>/gi)].map((m) => clean(m[1])).filter(Boolean);
    const text = clean(body);
    return {
      name: names[0] || '',
      names,
      seat: clean((body.match(/<span class="i">([\s\S]*?)<\/span>/i) || [])[1]),
      category: clean((body.match(/<p class="tag">([\s\S]*?)<\/p>/i) || [])[1]),
      date: clean((body.match(/<p class="date">([\s\S]*?)<\/p>/i) || [])[1]),
      che: (text.match(/CHE-\d{3}\.\d{3}\.\d{3}/) || [''])[0],
      text,
    };
  });
}

/** Match one notice: its name is the company, or (legal-form names only) the company is named in its text. */
function matchNotice(kw, a) {
  if (a.names.some((n) => sameCompany(kw, n))) return 'name';
  if (kw.form && ` ${norm(a.text)} `.includes(` ${kw.full} `)) return 'mentioned';
  return '';
}

function toRecord(a, how) {
  return {
    name: a.name,
    legal_form: canon(a.name).form,
    seat: a.seat,
    che_number: a.che,
    notice_category: a.category,
    notice_date: a.date,
    match: how,
    notice_text: a.text.slice(0, 400),
  };
}

function browserHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-CH,fr;q=0.9,en;q=0.7',
    ...extra,
  };
}

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return list.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const raw = String(keyword || '').trim();
  const kw = canon(raw);
  const deadline = Date.now() + BUDGET_MS;
  const fail = (status, reason, source_url, excerpt) => ({ status, reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });
  const refused = (s) => (s === 403 || s === 429 ? 'blocked' : 'http_error');
  const signal = () => AbortSignal.timeout(Math.max(1000, Math.min(25000, deadline - Date.now())));

  if (!kw.base) return fail('couldnt_check', 'other', SEARCH, 'empty company name');

  try {
    // 1. Session: the home page gives a cookie and the form token that the search POST needs.
    const home = await fetch(HOME, { headers: browserHeaders(), signal: signal() });
    if (!home.ok) return fail('couldnt_check', refused(home.status), HOME, `HTTP ${home.status}`);
    const homeHtml = await home.text();
    const token = (homeHtml.match(/name="search_home\[_token\]" value="([^"]+)"/) || [])[1];
    if (!token) {
      return fail('couldnt_check', /captcha|cf-chl|access denied/i.test(homeHtml) ? 'blocked' : 'layout_changed', HOME, 'no search form on the home page');
    }
    const cookie = cookieFrom(home);

    // 2. Site search. Returns { total, articles } or { error, reason }.
    const runSearch = async (query) => {
      if (Date.now() > deadline) return { error: true, reason: 'timeout', excerpt: 'lookup time budget used up' };
      const body = new URLSearchParams({
        'search_home[search]': query,
        'search_home[category]': 'all',
        'search_home[edition]': '',
        'search_home[_token]': token,
        'search_home[send]': '',
      });
      const res = await fetch(SEARCH, {
        method: 'POST',
        headers: browserHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://faovd.ch', 'Referer': HOME, 'Cookie': cookie }),
        body: body.toString(),
        signal: signal(),
      });
      if (!res.ok) return { error: true, reason: refused(res.status), excerpt: `HTTP ${res.status}` };
      const html = await res.text();
      const count = (html.match(/(\d+)\s+r[ée]sultats?\s+pour/i) || [])[1];
      if (!count && !/Aucun r[ée]sultat/i.test(html)) {
        return { error: true, reason: /captcha|cf-chl|access denied/i.test(html) ? 'blocked' : 'layout_changed', excerpt: 'unexpected search page' };
      }
      return { total: count ? Number(count) : 0, articles: parseArticles(html) };
    };

    // 3. Search with the full name, then with its longest word (the site search misses some full names).
    const queries = [raw];
    const longest = kw.base.split(' ').sort((a, b) => b.length - a.length)[0];
    if (longest.length >= 3 && norm(raw) !== longest) queries.push(longest);

    const found = new Map();
    const tried = [];
    let truncated = false;
    for (const q of queries) {
      const r = await runSearch(q);
      if (r.error) return fail('couldnt_check', r.reason, SEARCH, r.excerpt);
      tried.push(`"${q}": ${r.total} result(s), ${r.articles.length} shown`);
      for (const a of r.articles) {
        const how = matchNotice(kw, a);
        if (how) found.set(`${a.date}|${a.name}|${a.che}|${a.category}`, toRecord(a, how));
      }
      if (found.size) break;
      if (r.total > r.articles.length || r.total >= 100) truncated = true;
    }

    // 4. Nothing in search: the newest register notices (first two listing pages) cover notices the search index may lack.
    if (!found.size) {
      for (const page of [LISTING, `${LISTING}?page=2`]) {
        if (Date.now() > deadline) return fail('couldnt_check', 'timeout', page, 'lookup time budget used up');
        const res = await fetch(page, { headers: browserHeaders(), signal: signal() });
        if (!res.ok) return fail('couldnt_check', refused(res.status), page, `HTTP ${res.status}`);
        const articles = parseArticles(await res.text());
        if (!articles.length) return fail('couldnt_check', 'layout_changed', page, 'no notices on the register listing page');
        for (const a of articles) {
          const how = matchNotice(kw, a);
          if (how) found.set(`${a.date}|${a.name}|${a.che}|${a.category}`, toRecord(a, how));
        }
        if (found.size) break;
      }
    }

    if (found.size) {
      const records = [...found.values()];
      return { status: 'found', reason: '', records, source_url: SEARCH, excerpt: records[0].notice_text.slice(0, 300) };
    }
    if (truncated) {
      return fail('couldnt_check', 'other', SEARCH, `the search lists more results than it shows, so the company cannot be ruled out: ${tried.join('; ')}`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SEARCH,
      excerpt: `No notice for "${raw}" in the site search or the newest register notices. Searches: ${tried.join('; ')}`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', SEARCH, String(err?.message || err));
  }
}
