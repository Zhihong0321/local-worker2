export const meta = {
  task: 'VN-incham.vn',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'address', 'link'],
  canary: { found: 'ALLEGENS COMPANY LIMITED', not_found: 'CÔNG TY TNHH KHÔNG TỒN TẠI ABC' },
};

// Sources on incham.vn (public, no login):
//  1. WordPress REST API, custom post type "corporate-member" (search=...), JSON.
//  2. /members-incham/associate/ (static HTML list of associate members, name + address).
const SITE = 'https://incham.vn';
const CORP_API = `${SITE}/wp-json/wp/v2/corporate-member`;
const ASSOC_PAGE = `${SITE}/members-incham/associate/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Legal-form words ignored when comparing names (English and Vietnamese).
const LEGAL = new Set([
  'co', 'company', 'ltd', 'limited', 'jsc', 'joint', 'stock', 'pte', 'pvt', 'private', 'sdn', 'bhd',
  'llc', 'inc', 'corp', 'corporation', 'plc', 'gmbh', 'the', 'cong', 'ty', 'tnhh', 'ctcp', 'cp', 'phan',
  'mtv', 'trach', 'nhiem', 'huu', 'han', 'dntn',
]);

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function fold(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

function words(s) {
  return fold(s).replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}

// Comparison key: lower case, no punctuation, no legal form. "ALLEGENS COMPANY LIMITED" -> "allegens".
function coreKey(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join('');
}

function sameCompany(a, b) {
  const ka = coreKey(a);
  return ka !== '' && ka === coreKey(b);
}

async function get(url, accept) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.text();
    return { res, body, err: null };
  } catch (err) {
    return { res: null, body: '', err };
  }
}

function fetchFailure(url, r) {
  if (r.err) {
    const timedOut = r.err.name === 'TimeoutError' || r.err.name === 'AbortError';
    return { url, reason: timedOut ? 'timeout' : 'other', excerpt: String(r.err.message || r.err).slice(0, 300) };
  }
  const { status } = r.res;
  if (status === 403 || status === 429 || /captcha|cf-chl|verify you are human|access denied/i.test(r.body)) {
    return { url, reason: 'blocked', excerpt: `HTTP ${status}` };
  }
  if (status === 404) return { url, reason: 'layout_changed', excerpt: `HTTP 404` };
  if (!r.res.ok) return { url, reason: 'http_error', excerpt: `HTTP ${status}` };
  return null;
}

// Query the corporate-member REST endpoint. Returns { url, items } or { url, fail }.
async function queryCorporate(term) {
  const url = `${CORP_API}?per_page=100&search=${encodeURIComponent(term)}`;
  const r = await get(url, 'application/json');
  const f = fetchFailure(url, r);
  if (f) return { url, fail: f };
  let data;
  try {
    data = JSON.parse(r.body);
  } catch {
    return { url, fail: { url, reason: 'layout_changed', excerpt: r.body.slice(0, 300) } };
  }
  if (!Array.isArray(data)) {
    return { url, fail: { url, reason: 'layout_changed', excerpt: r.body.slice(0, 300) } };
  }
  const totalPages = Number(r.res.headers.get('x-wp-totalpages') || '1');
  if (totalPages > 1) {
    return { url, fail: { url, reason: 'other', excerpt: `search has ${totalPages} pages; only page 1 read` } };
  }
  return {
    url,
    items: data.map((x) => ({
      name: stripTags(x?.title?.rendered),
      link: decodeEntities(x?.link || ''),
    })),
  };
}

// Read the associate members list. Returns { url, items, count } or { url, fail }.
async function queryAssociate() {
  const r = await get(ASSOC_PAGE, 'text/html,application/xhtml+xml');
  const f = fetchFailure(ASSOC_PAGE, r);
  if (f) return { url: ASSOC_PAGE, fail: f };
  const body = r.body;
  if (!/Associate Members/i.test(body) || !/elementor-heading-title/.test(body)) {
    return { url: ASSOC_PAGE, fail: { url: ASSOC_PAGE, reason: 'layout_changed', excerpt: body.slice(0, 300) } };
  }
  const headingRe = /<h[1-6][^>]*class="[^"]*elementor-heading-title[^"]*"[^>]*>\s*<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h[1-6]>/gi;
  const items = [];
  let m;
  while ((m = headingRe.exec(body)) !== null) {
    const after = body.slice(m.index + m[0].length);
    // The address is the first <p> after this name, and only if no other name heading comes before it.
    const nextHeading = after.search(/<h[1-6][^>]*elementor-heading-title/i);
    const window = nextHeading >= 0 ? after.slice(0, nextHeading) : after.slice(0, 1500);
    const pm = window.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    items.push({
      name: stripTags(m[2]),
      link: decodeEntities(m[1]),
      address: pm ? stripTags(pm[1]) : '',
    });
  }
  if (items.length === 0) {
    return { url: ASSOC_PAGE, fail: { url: ASSOC_PAGE, reason: 'layout_changed', excerpt: 'no associate entries found' } };
  }
  return { url: ASSOC_PAGE, items, count: items.length };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword ?? '').trim();
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    // Search terms: the name without legal form, its first word, and the name as typed.
    const stripped = words(kw).filter((w) => !LEGAL.has(w));
    const terms = [...new Set([stripped.join(' '), stripped[0], kw].filter(Boolean))];

    const results = await Promise.all([queryAssociate(), ...terms.map(queryCorporate)]);
    const [assoc, ...corp] = results;

    const records = [];
    let matchUrl = '';
    const seen = new Set();

    for (const q of corp) {
      for (const it of q.items || []) {
        if (!sameCompany(it.name, kw)) continue;
        const key = coreKey(it.name) + '|' + it.link;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ name: it.name, list: 'corporate member', address: '', link: it.link });
        matchUrl = matchUrl || q.url;
      }
    }
    if (assoc.items) {
      for (const it of assoc.items) {
        if (!sameCompany(it.name, kw)) continue;
        const key = coreKey(it.name) + '|' + it.link;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ name: it.name, list: 'associate member', address: it.address, link: it.link });
        matchUrl = matchUrl || assoc.url;
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchUrl,
        excerpt: records.map((r) => `${r.name} (${r.list})`).join(' | ').slice(0, 500),
      };
    }

    // No match: only answer not_found when every source answered normally.
    const failures = [...corp, assoc].filter((q) => q.fail).map((q) => q.fail);
    if (failures.length > 0) {
      const f = failures[0];
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.url,
        excerpt: f.excerpt,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: corp[0].url,
      excerpt: `INCHAM corporate-member search (${terms.join(' / ')}): 0 matches; associate members list: ${assoc.count} entries, no match`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: CORP_API,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
