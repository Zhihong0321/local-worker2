export const meta = {
  task: 'IN-cci.gov.in',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['title', 'snippet', 'detail_url', 'doc_id', 'matched_name'],
  canary: { found: 'M/s Zucol Solutions Private Limited', not_found: 'ज़ेडक्सवाई सॉल्यूशंस प्राइवेट लिमिटेड' },
};

const BASE = 'https://www.cci.gov.in';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// How many result pages are read per lookup (fetched in parallel, so the total time stays one fetch long).
const PAGES = 3;
// Legal-form words, dropped on both sides before comparing names.
const LEGAL = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company',
  'corporation', 'corp', 'प्राइवेट', 'लिमिटेड']);

/** Drop the leading "M/s" that the site puts in front of party names. */
function cleanKeyword(s) {
  return String(s || '').normalize('NFKC').replace(/^\s*m\s*\/\s*s\.?\s+/i, '').trim();
}

/** Lower-case word tokens (letters, combining marks and digits kept, so Hindi words stay whole), legal forms removed. */
function tokens(s) {
  const text = String(s || '').normalize('NFKC').replace(/[​-‍﻿]/g, '').toLowerCase();
  return (text.match(/[\p{L}\p{M}\p{N}]+/gu) || []).filter((t) => !LEGAL.has(t));
}

function containsSeq(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** One search page: one entry per result block (document title, text snippet, detail page id). */
function parseResults(html) {
  const out = [];
  const parts = html.split('skyBlueBG searchbasic">').slice(1);
  for (const part of parts) {
    const idm = part.match(/search-filter-details\/(\d+)"\s+class="[^"]*titleFont[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!idm) continue;
    const snip = part.match(/<div class="row"><a[^>]*search-filter-details\/\d+"[^>]*>([\s\S]*?)<\/a>/);
    out.push({
      doc_id: idm[1],
      title: decode(idm[2]),
      snippet: snip ? decode(snip[1]) : '',
      detail_url: `${BASE}/search-filter-details/${idm[1]}`,
    });
  }
  return out;
}

/** Highest page number in the pagination links (the site shows the last page number). */
function totalPages(html) {
  const nums = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

function cc(reason, excerpt, url) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

function searchUrl(name, page) {
  return `${BASE}/search-filter?search_string=${encodeURIComponent(name)}${page > 1 ? `&page=${page}` : ''}`;
}

/** Read one search page. Never throws: a failure comes back as { bad } with a couldnt_check answer. */
async function readPage(name, page) {
  const url = searchUrl(name, page);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { bad: cc('blocked', `HTTP ${res.status}`, url) };
    if (!res.ok) return { bad: cc('http_error', `HTTP ${res.status}`, url) };
    const html = await res.text();
    const isSearchPage = html.includes('id="searchpageform"') || html.includes('Search Result</a>');
    if (!isSearchPage) {
      if (/captcha|access denied|are you a robot|cf-chl/i.test(html)) return { bad: cc('blocked', html.slice(0, 200), url) };
      return { bad: cc('layout_changed', html.slice(0, 200), url) };
    }
    return { url, hits: parseResults(html).map((h) => ({ ...h, page_url: url })), pages: totalPages(html) };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { bad: cc(timeout ? 'timeout' : 'other', String(err?.message || err), url) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = cleanKeyword(keyword);
  const firstUrl = searchUrl(name, 1);
  try {
    const want = tokens(name);
    if (!want.length) return cc('other', 'the name has no letters or numbers to search', firstUrl);

    const pages = await Promise.all(Array.from({ length: PAGES }, (_, i) => readPage(name, i + 1)));
    const ok = pages.filter((p) => !p.bad);

    const seen = new Set();
    const hits = ok.flatMap((p) => p.hits).filter((h) => (seen.has(h.doc_id) ? false : seen.add(h.doc_id)));
    const matches = hits.filter((h) => containsSeq(tokens(`${h.title} ${h.snippet}`), want));

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((m) => ({
          title: m.title,
          snippet: m.snippet.slice(0, 400),
          detail_url: m.detail_url,
          doc_id: m.doc_id,
          matched_name: name,
        })),
        source_url: matches[0].page_url,
        excerpt: (matches[0].title + ' — ' + matches[0].snippet).slice(0, 300),
      };
    }

    // No match on the pages we could read: a failed page or unread later pages means we cannot say "not listed".
    const bad = pages.find((p) => p.bad);
    if (bad) return bad.bad;
    const last = Math.max(...ok.map((p) => p.pages));
    if (last > PAGES) {
      return cc('other', `no match on pages 1-${PAGES} of ${last} for "${name}"; the remaining pages were not read`, firstUrl);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: hits.length === 0
        ? `Search returned 0 results for "${name}"`
        : `${hits.length} result(s) for "${name}", none names this company in its title or text`,
    };
  } catch (err) {
    return cc('other', String(err?.message || err), firstUrl);
  }
}
