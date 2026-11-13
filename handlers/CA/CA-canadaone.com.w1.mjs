export const meta = {
  task: 'CA-canadaone.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listing_url', 'website', 'verified_on', 'description', 'address'],
  canary: { found: '1675 Patisserie', not_found: 'Zyxqorvdeau Ltée' },
};

const BASE = 'https://www.canadaone.com';
const DIRECTORY = BASE + '/business/index.html';
const SEARCH_URL = DIRECTORY + '/CanadaOne/directory/search';
const RESULTS_PATH = '/business/index.html/CanadaOne/directory/map/p/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MAX_PAGES = 5;
const MAX_DETAILS = 2;
const PAGE_DEADLINE_MS = 30000;
const DETAIL_DEADLINE_MS = 42000;

// Legal-form words that are dropped at the end of a company name before comparing.
const LEGAL = new Set(['inc', 'incorporated', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'llc', 'llp', 'lp', 'ulc', 'ltee', 'cie', 'enr']);

function words(str) {
  return (str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalised core name: lower case, no punctuation or accents, no trailing legal form. */
function coreName(str) {
  const w = words(str);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join('');
}

/** The keyword as sent to the site's search box: the name with its trailing legal form removed. */
function searchText(keyword) {
  const parts = String(keyword).trim().split(/\s+/);
  while (parts.length > 1 && LEGAL.has(words(parts[parts.length - 1]).join(''))) parts.pop();
  return parts.join(' ');
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };

function cleanText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function headers(extra = {}) {
  return { 'User-Agent': UA, 'Accept': ACCEPT, 'Accept-Language': 'en-CA,en;q=0.8,fr-CA;q=0.6', ...extra };
}

function sessionCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const m = list.join(', ').match(/PHPSESSID=[^;,\s]+/);
  return m ? m[0] : '';
}

function blockedBody(html) {
  return /captcha|are you a robot|access denied|cf-chl|attention required/i.test(html.slice(0, 20000));
}

function parseResults(html) {
  const items = [];
  const re = /<li class="list-group-item">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const a = /<a href="(\/b\/[^"]+)">([\s\S]*?)<\/a>/.exec(m[1]);
    if (a) items.push({ href: new URL(a[1], BASE).href, name: cleanText(a[2]) });
  }
  return items;
}

function pageLinks(html) {
  const nums = new Set();
  const re = /directory\/map\/p\/(\d+)/g;
  let m;
  while ((m = re.exec(html))) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

function parseDetail(html) {
  const app = html.indexOf("id='app-container'");
  const block = app >= 0 ? html.slice(app, app + 8000) : html;
  const name = cleanText((html.match(/<h3 class='article-title'>([\s\S]*?)<\/h3>/) || [])[1]);
  const web = block.match(/<a target='_blank' href='(https?:\/\/[^']+)'/);
  const website = web ? web[1] : '';
  const verified = cleanText((block.match(/Verified on\s+([^<]+)/) || [])[1]).replace(/\s*\.?$/, '');
  const paras = [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => cleanText(x[1])).filter(Boolean);
  const description = paras.find((p) => p !== website && !/^https?:\/\//.test(p)) || '';
  const address = cleanText((block.match(/<address>([\s\S]*?)<\/address>/) || [])[1]).replace(/^P:\s*$/, '');
  return { name, website, verified_on: verified, description, address };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fail = (reason, excerpt, source_url = DIRECTORY) =>
    ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });
  try {
    const target = coreName(keyword);
    if (!target) return fail('other', 'no usable name in the input');
    const q = searchText(keyword);

    // 1. Search: the site keeps the search in the session, so the POST cookie is needed for the results page.
    const post = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': DIRECTORY }),
      body: new URLSearchParams({ 'search[keywords]': q, 'search[filter]': '' }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    if (post.status === 403 || post.status === 429) return fail('blocked', `HTTP ${post.status}`, SEARCH_URL);
    if (post.status >= 400) return fail('http_error', `HTTP ${post.status}`, SEARCH_URL);
    const cookie = sessionCookie(post);
    if (!cookie) return fail('layout_changed', 'search answered without a session cookie', SEARCH_URL);
    await post.body?.cancel?.();

    // 2. Results pages, one after another, until the name matches or the pages run out.
    const first = await fetch(BASE + RESULTS_PATH + '1', { headers: headers({ Cookie: cookie }), signal: AbortSignal.timeout(25000) });
    if (first.status === 403 || first.status === 429) return fail('blocked', `HTTP ${first.status}`, BASE + RESULTS_PATH + '1');
    if (!first.ok) return fail('http_error', `HTTP ${first.status}`, BASE + RESULTS_PATH + '1');
    const firstHtml = await first.text();
    if (blockedBody(firstHtml)) return fail('blocked', 'bot check or captcha on the results page', BASE + RESULTS_PATH + '1');
    // A search with no hits shows "No results found." instead of the "Search Results" list.
    if (!firstHtml.includes('Search Results') && !/No results found/i.test(firstHtml)) {
      return fail('layout_changed', firstHtml.slice(0, 300), BASE + RESULTS_PATH + '1');
    }

    const pages = [{ n: 1, html: firstHtml }];
    const seenPages = new Set([1]);
    let queue = pageLinks(firstHtml);
    let total = 0;
    let matches = [];
    let incomplete = false;

    const scan = (html) => {
      const items = parseResults(html);
      total += items.length;
      matches.push(...items.filter((it) => coreName(it.name) === target));
    };
    scan(firstHtml);

    while (matches.length === 0 && queue.length) {
      const n = queue.shift();
      if (seenPages.has(n)) continue;
      if (seenPages.size >= MAX_PAGES) { incomplete = true; break; }
      if (elapsed() > PAGE_DEADLINE_MS) { incomplete = true; break; }
      seenPages.add(n);
      const r = await fetch(BASE + RESULTS_PATH + n, { headers: headers({ Cookie: cookie }), signal: AbortSignal.timeout(25000) });
      if (!r.ok) return fail(r.status === 403 || r.status === 429 ? 'blocked' : 'http_error', `HTTP ${r.status} on results page ${n}`, BASE + RESULTS_PATH + n);
      const html = await r.text();
      if (blockedBody(html)) return fail('blocked', `bot check on results page ${n}`, BASE + RESULTS_PATH + n);
      pages.push({ n, html });
      scan(html);
      for (const p of pageLinks(html)) if (!seenPages.has(p) && !queue.includes(p)) queue.push(p);
    }

    if (matches.length === 0) {
      if (incomplete || queue.some((p) => !seenPages.has(p))) {
        return fail('timeout', `no exact match in the first ${seenPages.size} results page(s); more pages not read`, BASE + RESULTS_PATH + '1');
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE + RESULTS_PATH + '1',
        excerpt: `Search "${q}" returned ${total} listing(s) on ${pages.length} page(s); none is named "${keyword}"`,
      };
    }

    // 3. Detail pages of the matching listings (normally one).
    const records = [];
    for (const m of matches.slice(0, MAX_DETAILS)) {
      if (elapsed() > DETAIL_DEADLINE_MS && records.length) break;
      let d = null;
      try {
        const r = await fetch(m.href, { headers: headers({ Cookie: cookie }), signal: AbortSignal.timeout(25000) });
        if (r.ok) {
          const html = await r.text();
          if (!blockedBody(html)) d = parseDetail(html);
        }
      } catch {
        d = null;
      }
      records.push({
        name: (d && d.name) || m.name,
        listing_url: m.href,
        website: (d && d.website) || '',
        verified_on: (d && d.verified_on) || '',
        description: (d && d.description) || '',
        address: (d && d.address) || '',
      });
    }

    const first_rec = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first_rec.listing_url,
      excerpt: `${first_rec.name}: ${first_rec.description}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', String(err?.message || err));
  }
}
