export const meta = {
  task: 'PH-bworldonline.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'url', 'tag', 'matched_by'],
  canary: { found: 'Ayala Corp', not_found: 'Kompanyang Walang Balita Inc.' },
};

// BusinessWorld is a WordPress news site. Its public REST API (/wp-json/wp/v2) is used:
//  1. tags: the site tags articles with company names. A tag counts as the company only when its name, with the
//     legal form removed, equals the keyword's name with the legal form removed (exact word match, not substring).
//  2. articles under those tags. If no company tag exists, a relevance search for the name, and an article counts
//     only when its title or excerpt contains the name as whole words.
const BASE = 'https://bworldonline.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['corp', 'corporation', 'inc', 'incorporated', 'co', 'company', 'ltd', 'limited', 'plc', 'llc', 'pte', 'sdn', 'bhd', 'lp', 'the']);
const NO_NEW_REQUEST_AFTER_MS = 30000;

function words(s) {
  return String(s || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The name with punctuation, case and legal form removed, e.g. "Ayala Corp." -> "ayala". */
function coreOf(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join(' ');
}

/** True when the core name appears as whole words (not inside another word). */
function hasPhrase(text, core) {
  return core !== '' && (' ' + words(text).join(' ') + ' ').includes(' ' + core + ' ');
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ' '))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : ' '))
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** GET one REST URL and return its JSON array, or a couldnt_check answer in `fail`. */
async function getJson(url, started) {
  // Never start a request late: a request that starts after 30 s could run past the 60 s limit.
  if (Date.now() - started > NO_NEW_REQUEST_AFTER_MS) {
    return { fail: fail('timeout', url, 'stopped before this request to stay under 60 s') };
  }
  let res;
  let body;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    body = await res.text();
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: fail(timedOut ? 'timeout' : 'other', url, err && err.message) };
  }
  if (res.status === 403 || res.status === 429) return { fail: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: fail('http_error', url, `HTTP ${res.status}`) };

  let data;
  try {
    data = JSON.parse(body.replace(/^﻿/, ''));
  } catch {
    const botLike = /captcha|cf-chl|just a moment|verify you are human|access denied/i.test(body.slice(0, 5000));
    return { fail: fail(botLike ? 'blocked' : 'layout_changed', url, body.slice(0, 200)) };
  }
  if (!Array.isArray(data)) return { fail: fail('layout_changed', url, JSON.stringify(data).slice(0, 200)) };
  return {
    data,
    total: Number(res.headers.get('x-wp-total')),
    pages: Number(res.headers.get('x-wp-totalpages')),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let lastUrl = `${BASE}/`;
  try {
    const core = coreOf(keyword);
    if (!core) return fail('other', lastUrl, 'no company name left after removing punctuation and legal form');

    // Step 1: company tags. An exact tag (same words, legal form included, e.g. "Ayala Corp") is preferred;
    // only when there is none, a tag whose name equals the core name (e.g. "Ayala Corporation", "Ayala") is used.
    const fullKey = words(keyword).join(' ');
    const exactTags = [];
    const coreTags = [];
    for (let page = 1; page <= 3; page++) {
      lastUrl = `${BASE}/wp-json/wp/v2/tags?search=${encodeURIComponent(core)}&per_page=100&page=${page}&_fields=id,name,count`;
      const r = await getJson(lastUrl, started);
      if (r.fail) return r.fail;
      for (const t of r.data) {
        if (!(t.count > 0)) continue;
        if (words(t.name).join(' ') === fullKey) exactTags.push(t);
        else if (coreOf(t.name) === core) coreTags.push(t);
      }
      if (!(r.pages > page)) break;
    }
    const matchedTags = exactTags.length ? exactTags : coreTags;
    const matchedBy = exactTags.length ? 'tag_exact' : 'tag_core';

    if (matchedTags.length) {
      matchedTags.sort((a, b) => b.count - a.count);
      const ids = matchedTags.slice(0, 10).map((t) => t.id).join(',');
      lastUrl = `${BASE}/wp-json/wp/v2/posts?tags=${ids}&per_page=50&orderby=date&order=desc&_fields=id,date,link,title`;
      const r = await getJson(lastUrl, started);
      if (r.fail) return r.fail;
      if (r.data.length) {
        const tagLabel = matchedTags.map((t) => cleanText(t.name)).join(' | ');
        const records = r.data.map((p) => ({
          title: cleanText(p.title && p.title.rendered),
          date: String(p.date || '').slice(0, 10),
          url: p.link || '',
          tag: tagLabel,
          matched_by: matchedBy,
        }));
        return {
          status: 'found',
          reason: '',
          records,
          source_url: lastUrl,
          excerpt: `tag "${tagLabel}": ` + records.slice(0, 3).map((x) => x.title).join(' / '),
        };
      }
    }

    // Step 2: no company tag. Relevance search; count only articles that name the company in title or excerpt.
    lastUrl = `${BASE}/wp-json/wp/v2/posts?search=${encodeURIComponent(core)}&orderby=relevance&per_page=100&_fields=id,date,link,title,excerpt`;
    const r = await getJson(lastUrl, started);
    if (r.fail) return r.fail;

    const hits = r.data.filter((p) => {
      const title = cleanText(p.title && p.title.rendered);
      const excerpt = cleanText(p.excerpt && p.excerpt.rendered);
      return hasPhrase(title, core) || hasPhrase(excerpt, core);
    });

    if (!hits.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: lastUrl,
        excerpt: `no company tag and no article title/excerpt names "${core}" (checked ${r.data.length} of ${r.total} relevance results)`,
      };
    }

    const records = hits.map((p) => ({
      title: cleanText(p.title && p.title.rendered),
      date: String(p.date || '').slice(0, 10),
      url: p.link || '',
      tag: '',
      matched_by: 'title_or_excerpt',
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: lastUrl,
      excerpt: records.slice(0, 3).map((x) => x.title).join(' / ').slice(0, 300),
    };
  } catch (err) {
    return fail('other', lastUrl, String((err && err.message) || err));
  }
}
