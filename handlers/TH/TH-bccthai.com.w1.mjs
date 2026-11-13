export const meta = {
  task: 'TH-bccthai.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'corp_id', 'address', 'city', 'post_code', 'country', 'phone', 'url', 'member_since'],
  canary: { found: 'BRITISH AIRWAYS PLC', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' },
};

// BCCT member directory (YESmembers platform, reached via members.bccthai.com, public, no login).
// Search: POST corpsearch.asp (opt=a, inSelect, searchInput). Each result row links to corpdetail.asp?CorpID=N.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://members.bccthai.com/bcct/asp/';
const SEARCH_URL = BASE + 'corpsearch.asp';
const DETAIL_URL = BASE + 'corpdetail.asp?CorpID=';
const LEGAL = new Set(['sdn', 'bhd', 'pte', 'ltd', 'limited', 'plc', 'pcl', 'co', 'company', 'corp', 'corporation',
  'inc', 'llc', 'llp', 'public', 'the', 'บริษัท', 'จำกัด', 'มหาชน']);
const STOP = new Set(['of', 'and', 'for', 'in', 'the']);

class Failure extends Error {
  constructor(reason, excerpt, url) { super(reason); this.reason = reason; this.excerpt = excerpt; this.url = url; }
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case words of a name: accents, punctuation and case removed. Thai letters and marks are kept. */
function words(name) {
  return clean(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .map((w) => w.replace(/^บริษัท(?=.)/, '').replace(/(จำกัด|มหาชน)$/, ''))
    .filter(Boolean);
}

/** Comparison key: the name's words without the legal form. */
function keyOf(name) {
  return words(name).filter((w) => !LEGAL.has(w)).join(' ');
}

async function get(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(init.headers || {}) },
    signal: AbortSignal.timeout(25000),
  });
}

function checkStatus(res, url) {
  if (res.status === 403 || res.status === 429) throw new Failure('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new Failure('http_error', `HTTP ${res.status}`, url);
}

/** One directory search. Returns the result rows; throws Failure when the page is not a usable result page. */
async function search(term) {
  const res = await get(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': BASE + 'corpsearch.asp?opt=a&MenuCatID=1&MenuItemID=18&SponsorID=0',
    },
    body: new URLSearchParams({ opt: 'a', inSelect: 'AND', searchInput: term.slice(0, 50) }),
  });
  checkStatus(res, SEARCH_URL);
  const html = await res.text();
  const start = html.indexOf('compSearch');
  if (start < 0) {
    if (/name="Password"/.test(html)) throw new Failure('blocked', 'login page returned instead of the directory', SEARCH_URL);
    throw new Failure('layout_changed', html.slice(0, 300), SEARCH_URL);
  }
  const end = html.indexOf('id="footer"', start);
  const region = html.slice(start, end > start ? end : undefined);
  const rows = [];
  const re = /<a href="[^"]*corpdetail\.asp\?CorpID=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(region))) {
    const name = clean(m[2]);
    rows.push({ id: m[1], name, key: keyOf(name) });
  }
  if (!rows.length && !/No Matching Data Found/i.test(region)) {
    throw new Failure('layout_changed', clean(region).slice(0, 300), SEARCH_URL);
  }
  return rows;
}

/** Company detail page: address, city, post code, country, phone, URL, membership year. */
async function detail(id) {
  const url = DETAIL_URL + id;
  const res = await get(url);
  checkStatus(res, url);
  const html = await res.text();
  const i = html.indexOf('Directory - Companies, Detail');
  if (i < 0) throw new Failure('layout_changed', clean(html).slice(0, 300), url);
  const part = html.slice(i, i + 12000);
  const out = {};
  const re = /<td class="tabletext"[^>]*>([\s\S]*?)<\/td>\s*<td class="tabletext"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(part))) {
    const label = clean(m[1]).replace(/:\s*$/, '').toLowerCase();
    const value = clean(m[2]);
    if (!value || label === 'general email') continue; // the site shows "[members only]" for e-mail: not collected
    if (label === 'address') out.address = value;
    else if (label === 'city') out.city = value;
    else if (label === 'post code') out.post_code = value;
    else if (label === 'country') out.country = value;
    else if (label === 'phone number') out.phone = value;
    else if (label === 'url') out.url = value;
  }
  const since = html.match(/BCCT Member Company since\s*(\d{4})/i);
  if (since) out.member_since = since[1];
  out.source_url = url;
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let sourceUrl = SEARCH_URL;
  try {
    const name = clean(keyword);
    const key = keyOf(name);
    if (!key) throw new Failure('other', 'no company words in the name', SEARCH_URL);
    const terms = words(name).filter((w) => !LEGAL.has(w) && !STOP.has(w));

    // Search with all the words (AND). The site's own search is case-insensitive and ignores punctuation.
    let rows = await search(terms.join(' '));

    // Fallback with the longest single word, if the full search found no row with this name.
    // A listed name that has all the words also has this one, so this only widens the check.
    if (!rows.some((r) => r.key === key) && terms.length > 1) {
      if (elapsed() >= 15000) throw new Failure('timeout', 'site too slow to run the fallback search', SEARCH_URL);
      const longest = terms.reduce((a, b) => (b.length > a.length ? b : a));
      const more = await search(longest);
      const seen = new Set(rows.map((r) => r.id));
      rows = rows.concat(more.filter((r) => !seen.has(r.id)));
    }

    const matches = [];
    const seen = new Set();
    for (const r of rows) {
      if (r.key === key && !seen.has(r.id)) { seen.add(r.id); matches.push(r); }
    }

    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: rows.length ? `Directory answered with ${rows.length} other result(s); none has this name` : 'No Matching Data Found',
      };
    }

    // Detail pages in parallel. Only started while there is time left to finish under 60 s.
    const top = matches.slice(0, 5);
    let details = top.map(() => null);
    if (elapsed() < 35000) {
      const settled = await Promise.allSettled(top.map((r) => detail(r.id)));
      details = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
    }

    const records = top.map((r, idx) => {
      const d = details[idx] || {};
      const { source_url, ...fields } = d;
      return { name: r.name, corp_id: r.id, ...fields };
    });
    sourceUrl = details[0]?.source_url || (DETAIL_URL + top[0].id);

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: records.map((r) => [r.name, r.address, r.country].filter(Boolean).join(' | ')).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    if (err instanceof Failure) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || SEARCH_URL, excerpt: String(err.excerpt || '').slice(0, 300) };
    }
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
