export const meta = {
  task: 'DE-zvei.org',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_id', 'listed_under'],
  canary: { found: 'Bosch Rexroth AG', not_found: 'Nichtexistierende Musterfirma GmbH' },
};

// ZVEI "Our Members" list: server-rendered, one page per initial letter (plus 0-9).
// The letter pages can only be reached through the links on the list page (TYPO3 cHash), so the
// handler reads the list page first, takes the link for the name's initial, and reads that page.
const LIST_URL = 'https://www.zvei.org/en/association/membership/our-members';
const LETTER_PARAM = 'tx_zveimembers_zveimembers[letter]';
const DIGITS_KEY = '1234567890';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed before comparing names (after punctuation is stripped: "B.V." -> "bv").
const LEGAL_FORMS = new Set(['gmbh', 'ag', 'kg', 'co', 'se', 'mbh', 'ltd', 'bv', 'sas', 'sa', 'sarl', 'srl', 'spa',
  'ab', 'oy', 'ug', 'ohg', 'kgaa', 'gbr', 'ek', 'ev', 'plc', 'inc', 'llc', 'corp']);

/** Normalised comparison key: no diacritics, lower case, no punctuation, no legal form. */
function coreName(s) {
  const t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

async function getPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,de;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
  return { html: await res.text() };
}

/** Letter key -> absolute URL, read from the navigation links on the list page. */
function letterLinks(html, base) {
  const map = new Map();
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    if (!href.includes('letter%5D=') && !href.includes('letter]=')) continue;
    const u = new URL(href, base);
    const letter = u.searchParams.get(LETTER_PARAM);
    if (letter && !map.has(letter)) map.set(letter, u.href);
  }
  return map;
}

/** Member entries on a list page: { name, member_id }. */
function members(html) {
  const out = [];
  const re = /<article class="member item item-([0-9a-f-]+)"[^>]*>(?:(?!<\/article>)[\s\S])*?<h5 class="headline">([\s\S]*?)<\/h5>/g;
  let m;
  while ((m = re.exec(html))) {
    // The headline also holds id <span>s next to the name; drop them before reading the text.
    const name = decode(m[2].replace(/<span[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ').trim();
    if (name) out.push({ name, member_id: m[1] });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = coreName(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
               excerpt: 'the company name has no letters or digits to search for' };
    }

    // Step 1: the list page (its navigation holds the per-letter links).
    const home = await getPage(LIST_URL);
    if (home.fail) return { status: 'couldnt_check', ...home.fail, records: [], source_url: LIST_URL };
    const nav = letterLinks(home.html, LIST_URL);
    if (!nav.size || !home.html.includes('member-list')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
               excerpt: home.html.slice(0, 300) };
    }

    // Step 2: the page for the name's initial (the default page is the "A" list).
    const key = /[0-9]/.test(kw[0]) ? DIGITS_KEY : kw[0].toUpperCase();
    if (!nav.has(key)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL,
               excerpt: `the list has no page for the initial "${key}"` };
    }
    let pageHtml = home.html;
    let pageUrl = LIST_URL;
    if (key !== 'A') {
      pageUrl = nav.get(key);
      const page = await getPage(pageUrl);
      if (page.fail) return { status: 'couldnt_check', ...page.fail, records: [], source_url: pageUrl };
      pageHtml = page.html;
    }

    // Step 3: compare normalised names on that page.
    const list = members(pageHtml);
    if (!list.length) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl,
               excerpt: 'no member entries found on the list page' };
    }
    const label = key === DIGITS_KEY ? '0-9' : key;
    const seen = new Set();
    const records = [];
    for (const e of list) {
      if (coreName(e.name) !== kw) continue;
      const id = `${e.member_id}|${e.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      records.push({ name: e.name, member_id: e.member_id, listed_under: label });
    }

    if (!records.length) {
      return { status: 'not_found', reason: '', records: [], source_url: pageUrl,
               excerpt: `${list.length} entries on the "${label}" list page, none matches "${keyword}"` };
    }
    return { status: 'found', reason: '', records, source_url: pageUrl,
             excerpt: records.map((r) => r.name).join(' | ').slice(0, 500) };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: LIST_URL,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
