export const meta = {
  task: 'IE-nsai.ie',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'project_file_number', 'location', 'standard_number', 'standard_title', 'scope_of_registration'],
  canary: { found: 'Kingspan Ltd', not_found: 'Comhlacht Gan Ainm Teoranta' },
};

const SEARCH_PAGE = 'https://www.nsai.ie/certification/search-for-a-certified-company/';
const RESULTS_URL = 'https://www.nsai.ie/certification/results/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25000;

// Legal-form words that do not change which company is meant (English and Irish).
const LEGAL = new Set(['ltd', 'limited', 'teoranta', 'teo', 'dac', 'plc', 'uc', 'unlimited', 'company', 'co',
  'llc', 'inc', 'corp', 'corporation', 'llp', 'cic', 'ccc']);

function browserHeaders(extra) {
  return Object.assign({
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IE,en;q=0.9',
  }, extra || {});
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Lower-case word tokens, accents removed, "&" read as "and". Works for Irish (fadas) and other scripts.
function tokens(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Comparison key: no leading "the", no trailing legal form. "The Lawton Tube Co. Ltd" -> "lawton tube".
function coreKey(name) {
  let t = tokens(name);
  if (t[0] === 'the' && t.length > 1) t = t.slice(1);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t = t.slice(0, -1);
  return t.join(' ');
}

// The search box matches part of the name, so send the name without its trailing legal form.
function searchTerm(keyword) {
  const words = String(keyword || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = tokens(words[words.length - 1]);
    if (last.length === 1 && LEGAL.has(last[0])) words.pop();
    else break;
  }
  return words.join(' ') || String(keyword || '').trim();
}

function looksBlocked(html) {
  return /captcha|cf-chl|challenge-platform|are you a robot|access denied|attention required/i.test(html);
}

function setCookieValues(res) {
  let list = [];
  if (res.headers && typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else if (res.headers && res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')];
  return list;
}

// Step 1: open the search page. It gives a form token (XID), which is also the exp_csrf_token cookie value.
async function openSearchPage() {
  const res = await fetch(SEARCH_PAGE, { headers: browserHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', status: res.status };
  if (!res.ok) return { fail: 'http_error', status: res.status };
  const html = await res.text();
  if (looksBlocked(html)) return { fail: 'blocked', status: res.status };
  const xidMatch = html.match(/<form[^>]*action="[^"]*\/certification\/results\/?"[^>]*>[\s\S]*?name="XID"[^>]*value="([^"]+)"/i);
  if (!xidMatch || !/name="company_name"/i.test(html)) {
    return { fail: 'layout_changed', excerpt: html.slice(0, 300) };
  }
  let cookie = '';
  for (const c of setCookieValues(res)) {
    const m = c.match(/exp_csrf_token=([^;]+)/i);
    if (m && !/1970/.test(c)) cookie = m[1];
  }
  return { xid: xidMatch[1], cookie: cookie || xidMatch[1] };
}

// Step 2: post the search form with the token and session cookie.
async function postSearch(term, token) {
  const body = new URLSearchParams({
    XID: token.xid,
    company_name: term,
    standard_number: '',
    keywords: '',
    standard_title: '',
  });
  const res = await fetch(RESULTS_URL, {
    method: 'POST',
    headers: browserHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': SEARCH_PAGE,
      'Origin': 'https://www.nsai.ie',
      'Cookie': `exp_csrf_token=${token.cookie}`,
    }),
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', status: res.status };
  if (!res.ok) return { fail: 'http_error', status: res.status };
  const html = await res.text();
  if (/This form has expired/i.test(html)) return { fail: 'expired' };
  if (looksBlocked(html)) return { fail: 'blocked', status: res.status };
  return { html };
}

function parseResults(html) {
  const blocks = html.match(/<article[^>]*class="[^"]*\bresult\b[^"]*"[\s\S]*?<\/article>/g) || [];
  return blocks.map((block) => {
    const fileNo = (block.match(/article__category[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    const name = cleanText((block.match(/<h2[^>]*article__title[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || '');
    const rec = {
      name,
      project_file_number: cleanText(fileNo).replace(/^Project File Number:\s*/i, ''),
      location: '',
      standard_number: '',
      standard_title: '',
      scope_of_registration: '',
    };
    const metas = block.match(/<p[^>]*article__meta[^>]*>[\s\S]*?<\/p>/gi) || [];
    for (const p of metas) {
      const text = cleanText(p);
      const idx = text.indexOf(':');
      if (idx < 0) continue;
      const label = text.slice(0, idx).trim().toLowerCase();
      const value = text.slice(idx + 1).trim();
      if (label === 'location') rec.location = value;
      else if (label === 'standard number') rec.standard_number = value;
      else if (label === 'standard title') rec.standard_title = value;
      else if (label === 'scope of registration') rec.scope_of_registration = value;
    }
    return rec;
  }).filter((r) => r.name);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const term = searchTerm(kw);
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_PAGE, excerpt: 'empty company name' };
    }

    let html = null;
    let lastFail = null;
    for (let attempt = 1; attempt <= 2 && html === null; attempt++) {
      const token = await openSearchPage();
      if (token.fail) return { status: 'couldnt_check', reason: token.fail, records: [], source_url: SEARCH_PAGE, excerpt: token.excerpt || (token.status ? `HTTP ${token.status}` : '') };
      const post = await postSearch(term, token);
      if (post.fail === 'expired') { lastFail = post; continue; }
      if (post.fail) return { status: 'couldnt_check', reason: post.fail, records: [], source_url: SEARCH_PAGE, excerpt: post.status ? `HTTP ${post.status}` : '' };
      html = post.html;
    }
    if (html === null) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_PAGE, excerpt: 'search form kept expiring' };
    }

    if (!/Certified Companies Search Results/i.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_PAGE, excerpt: html.slice(0, 300) };
    }

    const results = parseResults(html);
    if (results.length === 0) {
      if (/returned no results|class="[^"]*\bno-results\b/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: SEARCH_PAGE, excerpt: `Search for "${term}": no results` };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_PAGE, excerpt: cleanText(html).slice(0, 300) };
    }

    const want = coreKey(kw);
    const matched = results.filter((r) => want !== '' && coreKey(r.name) === want);
    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_PAGE,
        excerpt: `Search for "${term}" returned ${results.length} certified company entries, none named "${kw}"`,
      };
    }

    const first = matched[0];
    return {
      status: 'found',
      reason: '',
      records: matched,
      source_url: SEARCH_PAGE,
      excerpt: `${first.name} | ${first.location} | ${first.standard_number} | ${first.project_file_number}`.slice(0, 500),
    };
  } catch (err) {
    const name = String(err && err.name || '');
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_PAGE,
      excerpt: String(err && err.message || err).slice(0, 300),
    };
  }
}
