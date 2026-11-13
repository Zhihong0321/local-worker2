export const meta = {
  task: 'VN-britchamvn.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'directory_url', 'description'],
  canary: { found: 'ActionAid International VietNam', not_found: 'Công ty Cổ phần Thương mại Dịch vụ Bình Minh Hưng Thịnh' },
};

const BASE = 'https://britchamvn.com';
const DIR_URL = `${BASE}/membership-directory/`;
const pageUrl = (pg) => `${DIR_URL}?inalpha=&pg=${pg}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });

/** Decode HTML entities and strip tags from a fragment. */
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : ''))
    .replace(/&#(\d+);/g, (_, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEGAL_PHRASES = /\b(trach nhiem huu han|mot thanh vien|cong ty|co phan)\b/g;
const LEGAL_TOKENS = new Set(['co', 'ltd', 'limited', 'company', 'jsc', 'corp', 'corporation', 'inc', 'llc', 'plc', 'pte', 'tnhh', 'cp', 'joint', 'stock']);

/** Compare form of a company name: no case, accents, punctuation or legal-form words. */
function normalize(s) {
  const ascii = decode(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  return ascii.replace(LEGAL_PHRASES, ' ').split(' ').filter((t) => t && !LEGAL_TOKENS.has(t)).join(' ');
}

/** One GET with the shared timeout. Returns { html } or { fail } (never throws for an HTTP answer). */
async function getPage(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status}`) };
  const html = await res.text();
  if (/<title>[^<]*(just a moment|access denied|attention required|captcha|security check|verify you are human)/i.test(html)) {
    return { fail: fail('blocked', url, 'bot check page') };
  }
  return { html };
}

/** Member entries on one list page: the name and the member's own directory page. */
function parseEntries(html) {
  const out = [];
  const re = /class="newstitle"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ url: new URL(m[1], BASE).href, name: decode(m[2]) });
  return out;
}

/** Last page number from the pagination links. */
function pageCount(html) {
  let max = 1;
  for (const m of html.matchAll(/[?&]pg=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Number of company choices in the directory's "Title" dropdown (the full name list, one per member). */
function dropdownCount(html) {
  const sel = html.match(/<select id="mdir_p_id"[\s\S]*?<\/select>/);
  if (!sel) return -1;
  return [...sel[0].matchAll(/<option[^>]*value="(\d+)"/g)].length;
}

/** The member's meta description (short company text). Best effort: '' when it cannot be read. */
async function describe(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return '';
    const m = (await res.text()).match(/<meta name="description" content="([^"]*)"/i);
    return m ? decode(m[1]) : '';
  } catch {
    return '';
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const q = normalize(keyword);
  if (!q) return fail('other', DIR_URL, 'no Latin letters to compare with the English directory names');
  try {
    const first = await getPage(pageUrl(1));
    if (first.fail) return first.fail;
    const pages = Math.min(pageCount(first.html), 50);

    const others = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getPage(pageUrl(i + 2))));
    const htmls = [first.html];
    for (const r of others) {
      if (r.fail) return r.fail;
      htmls.push(r.html);
    }

    const perPage = htmls.map(parseEntries);
    if (perPage.some((list) => list.length === 0)) {
      return fail('layout_changed', pageUrl(1), 'a directory list page had no member entries');
    }
    const seen = new Set();
    const entries = [];
    for (const e of perPage.flat()) {
      if (!seen.has(e.url)) { seen.add(e.url); entries.push(e); }
    }

    // Completeness guard: the list pages must hold every company in the directory's own dropdown,
    // otherwise a "not found" could be a missed page.
    const listed = dropdownCount(first.html);
    if (listed !== entries.length) {
      return fail('layout_changed', DIR_URL, `list pages show ${entries.length} entries, the company dropdown shows ${listed}`);
    }

    const hits = entries.filter((e) => normalize(e.name) === q);
    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: DIR_URL,
        excerpt: `Not in the member directory: ${entries.length} entries checked on ${pages} pages`,
      };
    }

    const records = [];
    for (const h of hits) {
      records.push({ name: h.name, directory_url: h.url, description: await describe(h.url) });
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: hits[0].url,
      excerpt: `${hits[0].name}: listed in the British Chamber of Commerce Vietnam member directory`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', DIR_URL, String(err?.message || err));
  }
}
