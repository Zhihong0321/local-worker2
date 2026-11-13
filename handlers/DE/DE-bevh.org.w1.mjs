export const meta = {
  task: 'DE-bevh.org',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership', 'website', 'detail_url', 'list_page'],
  canary: { found: 'AC Süppmayer GmbH', not_found: 'Phantasie Handelsgesellschaft mbH' },
};

// bevh member list: a plain, paginated HTML list (no search request). Every page is fetched with GET,
// each member is a teaser with its name in <div class="text-default-bold">.
const BASE = 'https://bevh.org';
const LIST_URL = `${BASE}/mitgliedschaft/mitgliederliste`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ITEM_MARK = '<div class="col-lg-3 col-md-4 col-xs-6 item">';
const BATCH = 4;
const START_LIMIT_MS = 30000; // no new batch after 30 s: worst case (one 25 s fetch) ends well inside 60 s

const LEGAL = new Set(['gmbh', 'ag', 'kg', 'ohg', 'gbr', 'ug', 'mbh', 'co', 'kgaa', 'se', 'ek', 'ltd', 'limited', 'inc',
  'llc', 'plc', 'sarl', 'sas', 'bv', 'nv', 'srl', 'spa', 'ab', 'oy', 'sdn', 'bhd', 'pte', 'pvt', 'corp', 'corporation',
  'kommanditgesellschaft', 'aktiengesellschaft']);

/** Lower case, umlauts as ae/oe/ue/ss, accents removed. */
function fold(str) {
  return String(str || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Normalised company core: no case, punctuation, spaces or legal form (GmbH, GmbH & Co. KG, e.K., ...). */
function core(str) {
  const s = fold(str)
    .replace(/gesellschaft mit beschraenkter haftung/g, ' ')
    .replace(/\be\.\s?k\.?/g, ' ')
    .replace(/\be k\b/g, ' ');
  return s.split(/[^a-z0-9]+/).filter((t) => t && !LEGAL.has(t)).join('');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Parse one list page into members. Returns null if the page does not look like the member list. */
function parseMembers(html, pageUrl) {
  const items = html.split(ITEM_MARK).length - 1;
  if (items === 0) return null;
  const chunks = html.split(ITEM_MARK).slice(1);
  const members = [];
  for (const c of chunks) {
    const nameM = c.match(/<div class="text-default-bold">([\s\S]*?)<\/div>/);
    const name = nameM ? clean(nameM[1]) : '';
    if (!name) continue;
    const memM = c.match(/icon-person[^"]*">\s*<a>([\s\S]*?)<\/a>/);
    const detM = c.match(/href="(\/mitgliedschaft\/mitgliederliste\/detail\/[^"]+)"/);
    const webM = c.match(/icon-web[^"]*">\s*<a[^>]*href="([^"]+)"/);
    members.push({
      name,
      membership: memM ? clean(memM[1]) : '',
      website: webM ? webM[1] : '',
      detail_url: detM ? new URL(detM[1], BASE).href : '',
      list_page: pageUrl,
    });
  }
  // every item must have produced a name, otherwise the layout is not what we expect
  return members.length === items ? members : null;
}

/** GET one page. Returns { html } or { fail: { reason, excerpt } }. */
async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status} at ${url}` } };
    if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status} at ${url}` } };
    const html = await res.text();
    if (/captcha|cf-chl|access denied/i.test(html) && !html.includes(ITEM_MARK)) {
      return { fail: { reason: 'blocked', excerpt: `bot or access check at ${url}` } };
    }
    return { html };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: { reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const input = String(keyword || '').trim();
    const want = core(input);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name after removing the legal form' };
    }

    // Page 1 tells us how many pages the list has.
    const first = await fetchText(LIST_URL);
    if (first.fail) return { status: 'couldnt_check', reason: first.fail.reason, records: [], source_url: LIST_URL, excerpt: first.fail.excerpt };
    const firstMembers = parseMembers(first.html, LIST_URL);
    if (!firstMembers) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: first.html.slice(0, 300) };
    }
    const pageNums = [...first.html.matchAll(/mitgliederliste\/member\/page-(\d+)/g)].map((m) => Number(m[1]));
    const lastPage = pageNums.length ? Math.max(...pageNums) : 1;

    const all = [...firstMembers];
    const pageUrls = [];
    for (let p = 2; p <= lastPage; p++) pageUrls.push(`${LIST_URL}/member/page-${p}`);

    for (let i = 0; i < pageUrls.length; i += BATCH) {
      if (Date.now() - started > START_LIMIT_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: LIST_URL, excerpt: 'member list not fully read within 30 s' };
      }
      const batch = pageUrls.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((u) => fetchText(u)));
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.fail) return { status: 'couldnt_check', reason: r.fail.reason, records: [], source_url: batch[j], excerpt: r.fail.excerpt };
        const members = parseMembers(r.html, batch[j]);
        if (!members) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: batch[j], excerpt: r.html.slice(0, 300) };
        }
        all.push(...members);
      }
    }

    const matches = all.filter((m) => core(m.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `read ${all.length} members on ${lastPage} list pages; none matches "${input}"`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.map(({ name, membership, website, detail_url, list_page }) => ({ name, membership, website, detail_url, list_page })),
      source_url: matches[0].list_page,
      excerpt: `${matches[0].name} | ${matches[0].membership}`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
