export const meta = { task: 'VN-vasep.com.vn', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'trade_name', 'address', 'province', 'activity', 'phone', 'email', 'website', 'eu_code', 'quality_certs', 'products'],
  canary: { found: 'CÔNG TY CỔ PHẦN HẢI VIỆT', not_found: 'CÔNG TY TNHH THỦY SẢN XYZZY KHÔNG TỒN TẠI' } };

// VASEP member directory (public). GET /hoi-vien?keyword=<text>&type=-1 lists matches, 20 per page.
// The site matches the Vietnamese spelling with accents, so the keyword keeps the accents the user typed.
const BASE = 'https://vasep.com.vn/hoi-vien';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'vi,en;q=0.8' };
const PAGE_SIZE = 20;
const MAX_PAGES = 5;
const MAX_DETAIL = 3;
const PAGE_BUDGET_MS = 35000;

// Legal-form words, as word lists (folded: no accents, lower case). Longest first.
const LEGAL_PHRASES = [
  'cong ty trach nhiem huu han', 'cong ty tnhh mot thanh vien', 'cong ty co phan', 'cong ty cp', 'cong ty tnhh', 'cong ty',
  'cty cp', 'cty tnhh', 'tnhh mot thanh vien', 'tnhh mtv', 'mot thanh vien', 'joint stock company', 'company limited',
  'private limited', 'pte ltd', 'sdn bhd', 'pvt ltd', 'co ltd', 'co phan', 'ctcp', 'tnhh', 'mtv', 'ltd', 'jsc', 'llc', 'plc',
  'inc', 'corp', 'corporation', 'co', 'cp',
].map(p => p.split(' ')).sort((a, b) => b.length - a.length);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripLegalWords(words) {
  const f = words.map(w => fold(w));
  const out = [];
  let i = 0;
  while (i < words.length) {
    let hit = 0;
    for (const p of LEGAL_PHRASES) {
      if (i + p.length <= words.length && p.every((pw, k) => f[i + k] === pw)) { hit = p.length; break; }
    }
    if (hit) i += hit; else { out.push(words[i]); i++; }
  }
  return out;
}

// Comparison key: accents, case, punctuation and legal form removed.
function core(name) {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  const kept = stripLegalWords(words);
  return fold((kept.length ? kept : words).join(' '));
}

// Search text: the user's words with the legal form removed, accents kept (the site needs them).
function searchTerm(keyword) {
  const words = keyword.split(/\s+/).filter(Boolean);
  const kept = stripLegalWords(words)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  return kept.length ? kept.join(' ') : keyword;
}

function decodeEntities(s) {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&#039;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function clean(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

// The site shows a reCAPTCHA widget on normal pages, so this is only checked when the expected content is missing.
function looksBlocked(html) {
  return /cf-chl|cf_chl|challenge-platform|access denied|are you a robot|unusual traffic/i.test(html);
}

function parseItems(html, base) {
  const out = [];
  const re = /<a href="([^"]*\/hoi-vien\/thong-tin\/[^"]*)">[\s\S]*?<span class="xtitle">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) out.push({ href: new URL(decodeEntities(m[1]), base).href, name: clean(m[2]) });
  return out;
}

const DETAIL_FIELDS = {
  CompanyName2: 'name', TradeName: 'trade_name', Address: 'address', City: 'province', Field: 'activity',
  Tel: 'phone', Email: 'email', Website: 'website', Code: 'eu_code', Quality: 'quality_certs', Product: 'products',
};

function parseDetail(html) {
  const rec = {};
  const re = /id="[^"]*_([A-Za-z0-9]+)" class="xvalue">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const key = DETAIL_FIELDS[m[1]];
    if (key) rec[key] = clean(m[2]);
  }
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').replace(/\s+/g, ' ').trim();
  if (!kw) return couldnt('other', BASE, 'empty company name');
  const target = core(kw);
  if (!target) return couldnt('other', BASE, 'no name left to compare after removing the legal form');

  const searchUrl = (term, page) => {
    const u = new URL(BASE);
    u.searchParams.set('keyword', term);
    u.searchParams.set('type', '-1');
    if (page > 1) u.searchParams.set('page', String(page));
    return u.href;
  };

  // Lists every result page for one search term until the exact name is found or the results run out.
  // Returns { matches, url } or { fail } (a couldnt_check result).
  async function scan(term) {
    const matches = [];
    let url = searchUrl(term, 1);
    for (let page = 1; ; page++) {
      if (page > 1 && Date.now() - started > PAGE_BUDGET_MS) {
        return { fail: couldnt('timeout', url, `stopped after ${page - 1} result pages to stay under 60 s`) };
      }
      url = searchUrl(term, page);
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) return { fail: couldnt('blocked', url, `HTTP ${res.status}`) };
      if (!res.ok) return { fail: couldnt('http_error', url, `HTTP ${res.status}`) };
      const html = await res.text();

      const items = parseItems(html, BASE);
      const emptyMsg = /Không tìm thấy dữ liệu/.test(html);
      const listing = /class="xcontent"/.test(html) || /_lblMessage"/.test(html);
      if (!listing || (items.length === 0 && !emptyMsg)) {
        if (looksBlocked(html)) return { fail: couldnt('blocked', url, 'bot check page instead of the directory') };
        return { fail: couldnt('layout_changed', url, html.slice(0, 300)) };
      }

      for (const it of items) if (core(it.name) === target) matches.push(it);
      if (matches.length) return { matches, url };
      if (items.length < PAGE_SIZE) return { matches, url };     // last page of results
      if (page >= MAX_PAGES) {
        return { fail: couldnt('other', url, `more than ${MAX_PAGES * PAGE_SIZE} results for "${term}"; the exact name was not among them`) };
      }
    }
  }

  try {
    const q = searchTerm(kw);
    let r = await scan(q);
    if (r.fail) return r.fail;
    let term = q;
    // The site stores some names with a double space (e.g. "THỦY  SẢN"), which a single-spaced search misses.
    // Retry with the last two words; the match is still by normalised full name.
    const words = q.split(' ');
    if (!r.matches.length && words.length >= 3) {
      term = words.slice(-2).join(' ');
      r = await scan(term);
      if (r.fail) return r.fail;
    }
    const matches = r.matches;
    const lastSearchUrl = r.url;

    if (!matches.length) {
      // The site matches accents exactly. A name typed without any accent may be stored with them, so no proof.
      if (!/[^\x00-\x7F]/.test(kw)) {
        return couldnt('other', lastSearchUrl, `no match for "${term}"; the name was typed without accents and the site search needs the accented spelling`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: lastSearchUrl,
        excerpt: `Không tìm thấy dữ liệu! No member of the VASEP directory matches "${term}".` };
    }

    const records = [];
    for (const m of matches.slice(0, MAX_DETAIL)) {
      const dr = await fetch(m.href, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (!dr.ok) {
        if (dr.status === 403 || dr.status === 429) return couldnt('blocked', m.href, `HTTP ${dr.status} on member page`);
        records.push({ name: m.name, detail_url: m.href, detail_note: `member page HTTP ${dr.status}` });
        continue;
      }
      const dh = await dr.text();
      const rec = parseDetail(dh);
      if (!rec.name) {
        if (looksBlocked(dh)) return couldnt('blocked', m.href, 'bot check page instead of the member page');
        return couldnt('layout_changed', m.href, dh.slice(0, 300));
      }
      records.push({ ...rec, detail_url: m.href });
    }

    const first = records[0];
    return {
      status: 'found', reason: '', records,
      source_url: records[0].detail_url,
      excerpt: [first.name, first.address, first.eu_code ? `EU code ${first.eu_code}` : ''].filter(Boolean).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', searchUrl(searchTerm(kw), 1), timeout ? 'request timed out' : String(err && err.message || err));
  }
}
