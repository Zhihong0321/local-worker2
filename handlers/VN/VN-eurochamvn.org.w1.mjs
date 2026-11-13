export const meta = { task: 'VN-eurochamvn.org', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'profile_url'],
  canary: { found: 'ABB ROBOTICS VIETNAM COMPANY LIMITED', not_found: 'Công ty Cổ phần Xyz Không Tồn Tại' } };

// EuroCham Vietnam member directory: https://eurochamvn.org/members/?q=<name>
// Server-rendered list, paginated as /members/page/N?q=<name>. No login, no token.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const PAGE_MS = 25000;       // per fetch (contract)
const BUDGET_MS = 45000;     // stop starting new pages after this, to finish under 60 s
const MAX_PAGES = 40;

// English legal-form words, dropped from the search term (kept as typed otherwise).
const LEGAL_WORDS = new Set(['company', 'co', 'ltd', 'limited', 'llc', 'jsc', 'inc', 'corp', 'corporation', 'pte', 'sdn', 'bhd', 'plc', 'gmbh', 'joint', 'stock']);

// Legal-form phrases dropped from names before comparing (on folded text, space-padded).
const LEGAL_PHRASES = ['cong ty trach nhiem huu han', 'cong ty co phan', 'cong ty tnhh', 'cong ty', 'co phan', 'trach nhiem huu han',
  'tnhh', 'cty', 'cp', 'joint stock company', 'joint stock', 'company', 'corporation', 'limited', 'ltd', 'llc', 'jsc', 'inc', 'corp',
  'pte', 'sdn bhd', 'bhd', 'plc', 'gmbh', 'co'];

/** Lower-case, accents and đ removed, punctuation to single spaces. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalised name without legal form, e.g. "ABB ROBOTICS VIETNAM COMPANY LIMITED" -> "abb robotics vietnam". */
function core(name) {
  let s = ' ' + fold(name) + ' ';
  let before;
  do {
    before = s;
    for (const p of LEGAL_PHRASES) s = s.split(' ' + p + ' ').join(' ');
  } while (s !== before);
  return s.replace(/\s+/g, ' ').trim();
}

/** Search term: the name as typed, minus English legal-form words. */
function searchTerm(keyword) {
  const kept = keyword.split(/\s+/).filter((t) => {
    const w = t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    return w && !LEGAL_WORDS.has(w);
  });
  return (kept.join(' ').trim() || keyword).slice(0, 200);
}

function pageUrl(n, q) {
  const base = n === 1 ? 'https://eurochamvn.org/members/' : `https://eurochamvn.org/members/page/${n}`;
  return `${base}?q=${encodeURIComponent(q)}`;
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseCards(html) {
  const out = [];
  const re = /<a href="([^"]*)" class="mdapi-member"[\s\S]*?<div class="mdapi-member__title">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = decode(m[2]).replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    if (name) out.push({ name, profile_url: decode(m[1]) });
  }
  return out;
}

function lastPage(html) {
  const pag = html.match(/mdapi-members__pagination"[\s\S]*?<\/div>/);
  if (!pag) return 1;
  const nums = [...pag[0].matchAll(/data-page="(\d+)"/g)].map((x) => Number(x[1]));
  return nums.length ? Math.max(...nums) : 1;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  let url = pageUrl(1, kw);
  try {
    const target = core(kw);
    if (!target) return fail('other', url, 'the name has no words left after removing the legal form');
    const q = searchTerm(kw);
    let page = 1, last = 1, cards = 0, complete = false, hits = [];

    while (page <= MAX_PAGES) {
      url = pageUrl(page, q);
      if (Date.now() - started > BUDGET_MS) return fail('timeout', url, `checked ${page - 1} of ${last} result pages before the time limit`);

      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(PAGE_MS) });
      if (res.status === 403 || res.status === 429) return fail('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (/<title>\s*Just a moment|cf-chl|challenge-platform/i.test(html)) return fail('blocked', url, 'bot check page');
      if (!html.includes('mdapi-members__wrapper') || !html.includes('mdapi-members')) {
        return fail('layout_changed', url, html.replace(/\s+/g, ' ').slice(0, 300));
      }

      if (page === 1) last = lastPage(html);
      const list = parseCards(html);
      cards += list.length;
      hits = list.filter((c) => core(c.name).replace(/ /g, '') === target.replace(/ /g, ''))
        .map((c) => ({ name: c.name, profile_url: c.profile_url }));
      if (hits.length) {
        return { status: 'found', reason: '', records: hits, source_url: url,
          excerpt: `${hits[0].name} (${hits.length} listing${hits.length > 1 ? 's' : ''} on EuroCham member directory)`.slice(0, 500) };
      }
      if (page >= last) { complete = true; break; }
      page++;
    }

    if (!complete) {
      return fail('other', url, `search has ${last} result pages; the first ${MAX_PAGES} were checked without a match`);
    }
    if (cards === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: pageUrl(1, q), excerpt: `No members matched "${q}"`.slice(0, 500) };
    }
    return { status: 'not_found', reason: '', records: [], source_url: pageUrl(1, q),
      excerpt: `${cards} listing(s) matched "${q}" on ${last} page(s); none has the same name`.slice(0, 500) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', url, String((err && err.message) || err).slice(0, 300));
  }
}
