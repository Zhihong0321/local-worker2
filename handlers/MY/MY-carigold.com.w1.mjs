export const meta = {
  task: 'MY-carigold.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['title', 'url', 'author', 'snippet'],
  canary: { found: 'Speedmatrix Sdn Bhd', not_found: 'Syarikat Tiada Rekod Sdn Bhd' },
};

// CariGold is a forum. Its guest-visible search (XenForo) is the only lookup by name: it returns the threads and
// posts that contain the name. There are no company register records on the site.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://carigold.com';
const SEARCH_PAGE = `${BASE}/forum/search/`;
const SEARCH_POST = `${BASE}/forum/search/search`;
const OVERALL_MS = 55000;

function clean(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop the legal form (SDN BHD, BERHAD, PLT, LLP...) and a trailing registration number, so the core name is searched. */
function coreName(name) {
  let s = (name || '').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*\((?:m|malaysia|[^)]*\d[^)]*)\)\s*$/i, '');
    s = s.replace(/[\s,.\-]*\b(sdn\.?\s*bhd\.?|berhad|bhd\.?|plt|llp)\s*\.?\s*$/i, '');
    s = s.replace(/[\s,.\-]+$/, '').trim();
  } while (s !== prev);
  return s;
}

function blockedOr(status, url) {
  if (status === 403 || status === 429) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${status}` };
  }
  return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${status}` };
}

async function run(keyword) {
  const core = coreName(keyword);
  if (!core || core.replace(/[^a-z0-9]/gi, '').length < 2) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_PAGE,
      excerpt: `no distinctive name left after removing the legal form from "${keyword}"` };
  }

  // 1. Open the search page: sets the session cookie and gives the form token.
  const r1 = await fetch(SEARCH_PAGE, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
  if (!r1.ok) return blockedOr(r1.status, SEARCH_PAGE);
  const page = await r1.text();
  const token = (page.match(/name="_xfToken" value="([^"]+)"/) || [])[1];
  if (!token) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_PAGE, excerpt: clean(page).slice(0, 300) };
  }
  const cookie = (typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

  // 2. Run the search as a guest. The quotes make it an exact phrase, so "Syarikat Tiada Rekod" does not match every "Sdn Bhd".
  const body = new URLSearchParams({ keywords: `"${core.replace(/"/g, ' ')}"`, _xfToken: token, order: 'date' });
  const r2 = await fetch(SEARCH_POST, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': SEARCH_PAGE,
      'Origin': BASE,
      ...(cookie ? { 'Cookie': cookie } : {}),
    },
    body,
    signal: AbortSignal.timeout(25000),
  });
  const resultUrl = r2.url || SEARCH_POST;
  if (!r2.ok) return blockedOr(r2.status, resultUrl);
  if (/\/login/i.test(resultUrl)) {
    return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: resultUrl, excerpt: 'search redirected to the login page' };
  }
  const html = await r2.text();
  if (/Security error occurred/i.test(html)) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: resultUrl, excerpt: 'the site refused the search form (security token)' };
  }

  // 3. Read the result list.
  const items = html.match(/<li class="block-row[\s\S]*?<\/li>/g) || [];
  if (items.length === 0) {
    if (/No results found/i.test(html)) {
      return {
        status: 'not_found', reason: '', records: [], source_url: resultUrl,
        excerpt: `0 results for "${core}" in the guest search (members-only sections are not searched)`,
      };
    }
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: resultUrl, excerpt: clean(html).slice(0, 300) };
  }

  const records = items.map((it) => {
    const link = it.match(/<h3 class="contentRow-title">\s*<a href="([^"]+)"/);
    const title = clean((it.match(/<h3 class="contentRow-title">([\s\S]*?)<\/h3>/) || [])[1]);
    const snippet = clean((it.match(/<div class="contentRow-snippet">([\s\S]*?)<\/div>/) || [])[1]).slice(0, 400);
    const author = (it.match(/data-author="([^"]*)"/) || [])[1] || '';
    return {
      title,
      url: link ? new URL(link[1].replace(/&amp;/g, '&'), BASE).href : '',
      author: clean(author),
      snippet,
    };
  });

  return {
    status: 'found',
    reason: '',
    records,
    source_url: resultUrl,
    excerpt: `${records.length} guest-visible thread/post hit(s) for "${core}": ${records[0].title}`.slice(0, 500),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'couldnt_check', reason: 'timeout', records: [], source_url: SEARCH_PAGE,
      excerpt: `the lookup did not finish in ${OVERALL_MS / 1000} s`,
    }), OVERALL_MS);
  });
  try {
    return await Promise.race([run(String(keyword ?? '')), guard]);
  } catch (err) {
    const msg = String(err?.name === 'TimeoutError' ? 'timeout' : (err?.message || err));
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_PAGE,
      excerpt: msg.slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}
