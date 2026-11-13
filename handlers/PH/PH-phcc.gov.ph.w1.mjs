export const meta = {
  task: 'PH-phcc.gov.ph',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'decision_date', 'case_reference', 'document_url'],
  canary: { found: 'Globe Fintech Innovations, Inc.', not_found: 'Kompanyang Hindi Nakalista Inc.' },
};

// PCC "Commission Decisions" list: GET with keyword search, 10 rows per page, server-side paging.
// A company is "found" when its normalised name appears in a decision title (the parties are named in the title).
const BASE = 'https://www.phcc.gov.ph/commission-issuance';
const CATEGORY = 'commission-decisions';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'bhd', 'sdn', 'pte', 'plc', 'llc', 'llp', 'lp', 'opc']);
const MAX_PAGES = 15;
const TIME_BUDGET_MS = 40000;

function tokens(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Name tokens without legal-form words, for matching. */
function coreTokens(name) {
  return tokens(name).filter((t) => !LEGAL.has(t));
}

/** Search text: the name as typed, with trailing legal-form words and punctuation removed. */
function searchText(name) {
  const words = String(name || '').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && LEGAL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.length ? words.join(' ') : String(name || '').trim();
}

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function searchUrl(q, page) {
  const u = new URL(BASE);
  u.searchParams.set('category', CATEGORY);
  u.searchParams.set('keyword', q);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

async function getHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status}` };
    return { html: await res.text() };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { fail: timeout ? 'timeout' : 'other', detail: String(err?.message || err).slice(0, 200) };
  }
}

function looksLikeResults(html) {
  return /<table[\s\S]*?<\/table>/i.test(html) && /<tbody/i.test(html) && /name="keyword"/i.test(html);
}

function lastPage(html) {
  let max = 1;
  for (const m of html.matchAll(/[?&;]page=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function parseRows(html) {
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || '';
  const rows = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 2) continue; // "No resources found." is a single full-width cell
    const href = row.match(/href="([^"]+)"/i)?.[1] || '';
    let documentUrl = '';
    try { documentUrl = href ? new URL(decode(href), BASE).href : ''; } catch { documentUrl = ''; }
    out.push({ title: cleanText(cells[0]), category: cleanText(cells[1]), documentUrl });
  }
  return out;
}

function mentionsCompany(title, core) {
  if (!core.length) return false;
  const t = tokens(title).filter((x) => !LEGAL.has(x));
  for (let i = 0; i + core.length <= t.length; i++) {
    let ok = true;
    for (let j = 0; j < core.length; j++) {
      if (t[i + j] !== core[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function toRecord(r) {
  const date = r.title.match(/dated\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)?.[1] || '';
  const caseRef = r.title.match(/\b(?:PCC|MAO)\s+Case\s+No\.?\s*[A-Z0-9-]+/i)?.[0] || '';
  return { name: r.title, category: r.category, decision_date: date, case_reference: caseRef, document_url: r.documentUrl };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  const q = searchText(input);
  const core = coreTokens(input);
  const firstUrl = searchUrl(q, 1);
  try {
    if (!input || !core.length) return couldnt('other', firstUrl, 'no usable company name in the input');

    const matches = [];
    let pageNo = 1;
    let pages = 1;
    let truncated = false;
    let failReason = '';
    let failDetail = '';
    let rowsSeen = 0;

    for (;;) {
      const url = searchUrl(q, pageNo);
      const got = await getHtml(url);
      if (got.fail) {
        if (pageNo === 1) return couldnt(got.fail, url, got.detail);
        failReason = got.fail;
        failDetail = got.detail;
        truncated = true;
        break;
      }
      const html = got.html;
      const noResults = /No resources found/i.test(html);
      if (pageNo === 1 && !noResults && !looksLikeResults(html)) {
        return couldnt(/captcha|cf-chl|access denied/i.test(html) ? 'blocked' : 'layout_changed', url, html.slice(0, 300));
      }
      if (pageNo === 1) pages = lastPage(html);
      const rows = parseRows(html);
      if (!rows.length && !noResults) {
        if (pageNo === 1) return couldnt('layout_changed', url, html.slice(0, 300));
        break;
      }
      rowsSeen += rows.length;
      for (const r of rows) if (mentionsCompany(r.title, core)) matches.push(r);

      if (pageNo >= pages) break;
      if (pageNo >= MAX_PAGES || Date.now() - started > TIME_BUDGET_MS) {
        truncated = true;
        failDetail = `read ${pageNo} of ${pages} result pages before the time limit`;
        break;
      }
      pageNo++;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: firstUrl,
        excerpt: matches[0].title.slice(0, 500),
      };
    }
    if (truncated) {
      return couldnt(failReason || 'other', firstUrl,
        `no match in the pages read; ${failDetail}. Absence not confirmed.`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: rowsSeen ? `${rowsSeen} ${CATEGORY} entries for "${q}", none names this company` : 'No resources found.',
    };
  } catch (err) {
    const name = err?.name || '';
    return couldnt(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
