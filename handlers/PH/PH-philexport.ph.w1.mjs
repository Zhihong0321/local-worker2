export const meta = { task: 'PH-philexport.ph', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'listed_on', 'page_url'], canary: { found: 'Mehitabel Inc.', not_found: 'Kumpanyang Walang Pangalan Inc.' } };

// PHILEXPORT is a WordPress site. Its own search (/?s=<name>) finds pages; the "Company Member" page
// holds a table of member companies (cells with id="name"). The handler searches, opens the pages the
// search returns, and keeps only table cells whose normalised name equals the normalised input.
const BASE = 'https://philexport.ph';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd', 'limited', 'opc', 'llc', 'sdn', 'bhd', 'pte', 'plc', 'gmbh', 'llp', 'lp']);
const MAX_SEARCH_PAGES = 5;
const BUDGET_MS = 30000; // no new fetch starts after 30 s, so the whole call ends well under 60 s

function clean(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
// Normalised name without a trailing legal form ("ACME TRADING SDN BHD" -> "acme trading").
function core(name) {
  const t = clean(name).split(' ').filter(Boolean);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}
function decode(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function text(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow', signal: AbortSignal.timeout(25000) });
  return { status: res.status, body: await res.text(), url: res.url };
}
const isTimeout = (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError');
const fail = (status, reason, excerpt, source_url = '') =>
  ({ status, reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });

export default async function lookup(keyword) {
  const t0 = Date.now();
  const outOfTime = () => Date.now() - t0 > BUDGET_MS;
  try {
    const q = core(keyword ?? '');
    if (!q) return fail('couldnt_check', 'other', 'no company name given');
    const search = `${BASE}/?s=${encodeURIComponent(q)}`;

    // 1. Search result pages: collect the permalinks of the matching pages.
    const permalinks = [];
    let n = 1;
    let url = search;
    for (;;) {
      if (outOfTime()) return fail('couldnt_check', 'timeout', 'search pages not all read within 30 s', search);
      let r;
      try { r = await get(url); } catch (e) {
        return fail('couldnt_check', isTimeout(e) ? 'timeout' : 'other', `search request failed: ${String(e).slice(0, 200)}`, url);
      }
      if (r.status === 403 || r.status === 429) return fail('couldnt_check', 'blocked', `HTTP ${r.status} on ${url}`, url);
      if (r.status !== 200) return fail('couldnt_check', 'http_error', `HTTP ${r.status} on ${url}`, url);
      if (!/Search Results for/i.test(r.body)) {
        if (n > 1) break; // a later result page that is not a results page: the list has ended
        const challenge = /cf-chl|Just a moment\.\.\.|verify you are human/i.test(r.body);
        return fail('couldnt_check', challenge ? 'blocked' : 'layout_changed', 'search page is not the expected results page', url);
      }
      const parts = r.body.split('<article').slice(1);
      for (const part of parts) {
        const m = part.match(/<h2><a href="([^"]+)"/);
        if (m && !permalinks.includes(m[1])) permalinks.push(m[1]);
      }
      if (!r.body.includes(`/page/${n + 1}/?s=`)) break; // no further search result page
      if (n >= MAX_SEARCH_PAGES) {
        return fail('couldnt_check', 'other', `search has more than ${MAX_SEARCH_PAGES} result pages; not all checked`, search);
      }
      n += 1;
      url = `${BASE}/page/${n}/?s=${encodeURIComponent(q)}`;
    }
    if (permalinks.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: search,
        excerpt: `Search for "${q}" returned no results.` };
    }

    // 2. Open each result page and look for the company in its name cells.
    const records = [];
    let unreadable = null;
    let layoutDoubt = false;
    for (const link of permalinks) {
      if (outOfTime()) { unreadable = unreadable || ['timeout', 'result pages not all read within 30 s']; break; }
      let r;
      try { r = await get(link); } catch (e) {
        unreadable = unreadable || [isTimeout(e) ? 'timeout' : 'other', `could not open ${link}: ${String(e).slice(0, 150)}`];
        continue;
      }
      if (r.status === 403 || r.status === 429) { unreadable = unreadable || ['blocked', `HTTP ${r.status} on ${link}`]; continue; }
      if (r.status !== 200) { unreadable = unreadable || ['http_error', `HTTP ${r.status} on ${link}`]; continue; }
      const title = text((r.body.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s*-\s*PHILEXPORT Portal\s*$/i, '');
      const cells = [...r.body.matchAll(/<td[^>]*\bid="name"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1])).filter(Boolean);
      if (cells.length === 0) {
        if ((' ' + clean(text(r.body)) + ' ').includes(' ' + q + ' ')) layoutDoubt = true;
        continue;
      }
      for (const cell of cells) {
        if (core(cell) === q && !records.some((x) => x.name === cell && x.page_url === link)) {
          records.push({ name: cell, listed_on: title, page_url: link });
        }
      }
    }

    if (records.length > 0) {
      const first = records[0];
      return { status: 'found', reason: '', records, source_url: search,
        excerpt: `Listed on "${first.listed_on}" as: ${first.name}`.slice(0, 300) };
    }
    if (unreadable) return fail('couldnt_check', unreadable[0], unreadable[1], search);
    if (layoutDoubt) return fail('couldnt_check', 'layout_changed', 'result page has no member name table', search);
    return { status: 'not_found', reason: '', records: [], source_url: search,
      excerpt: `Search for "${q}" matched ${permalinks.length} page(s); none lists this company as a member.` };
  } catch (e) {
    return fail('couldnt_check', 'other', `handler error: ${String(e).slice(0, 200)}`);
  }
}
