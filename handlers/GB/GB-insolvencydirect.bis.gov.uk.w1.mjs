export const meta = { task: 'GB-insolvencydirect.bis.gov.uk', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'trading_name', 'trading_address', 'postcode', 'case_url'],
  canary: { found: 'Glocal Foods Ltd', not_found: 'Zzqxv Blorf Ltd' } };

// The register holds INDIVIDUALS. A company only appears here as a trading name of a person.
// This handler searches the name box and matches a record only when one of the person's trading names equals the company name.

const BASE = 'https://www.insolvencydirect.bis.gov.uk';
const SEARCH_URL = `${BASE}/eiir/search`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BUDGET_MS = 33000;   // do not start a new request after this (keeps the whole call under 60 s)
const MAX_PAGES = 25;      // 25 pages x 10 records

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise a company name: case, punctuation, '&', and legal-form wording. */
function normName(str) {
  let s = decode(str).toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bpublic limited company\b/g, 'plc')
       .replace(/\blimited\b/g, 'ltd')
       .replace(/\bcompany\b/g, 'co')
       .replace(/\bincorporated\b/g, 'inc');
  return s.replace(/\s+/g, ' ').trim();
}

function sameName(a, b) {
  const x = normName(a), y = normName(b);
  return x !== '' && (x === y || x.replace(/ /g, '') === y.replace(/ /g, ''));
}

function storeCookies(res, jar) {
  let list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length && res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')];
  for (const c of list) {
    const pair = c.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function go(url, init, jar) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    ...(init.headers || {}),
  };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(25000) });
}

function parseRow(rowHtml) {
  const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
  if (tds.length < 4) return null;
  const link = tds[0].match(/<a[^>]*href="([^"]*case-details[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!link) return null;
  const trading = [];
  for (const m of tds[2].matchAll(/<TradingDetails>([\s\S]*?)<\/TradingDetails>/gi)) {
    // the site writes line breaks as <br> or </br>
    const parts = m[1].split(/<\/?br\s*\/?>/i).map(decode).filter(Boolean);
    if (parts.length) trading.push({ name: parts[0], address: parts.slice(1).join(', ') });
  }
  return {
    name: decode(link[2]),
    case_url: new URL(link[1], BASE).href,
    postcode: decode(tds[3]),
    trading,
  };
}

/** Returns { kind: 'none' | 'records' | 'unknown', total, rows } for one results page. */
function parsePage(html) {
  if (/find any results/i.test(html)) return { kind: 'none' };
  const sum = html.match(/Your search returned\s*<span[^>]*>\s*([\d,]+)\s*<\/span>\s*records/i);
  if (!sum) return { kind: 'unknown' };
  const total = parseInt(sum[1].replace(/,/g, ''), 10);
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || '';
  const rowHtmls = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const rows = rowHtmls.map(parseRow).filter(Boolean);
  return { kind: 'records', total, rows, rawRows: rowHtmls.length };
}

async function fetchResultsPage(url, jar) {
  const res = await go(url, { method: 'GET' }, jar);
  storeCookies(res, jar);
  const html = res.ok ? await res.text().catch(() => '') : '';
  return { status: res.status, ok: res.ok, html };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const term = String(keyword ?? '').replace(/\s+/g, ' ').trim();
  if (!term) return out('couldnt_check', 'other', SEARCH_URL, 'empty company name');
  // The site's search is literal ("Limited" does not find "Ltd"), so search the name without its legal form.
  // The match below still compares the full typed name, legal form included.
  const searchTerm = term.replace(/[\s,]+(public limited company|limited|ltd\.?|plc|llp)$/i, '').trim() || term;
  const jar = new Map();
  let stage = 'search form';
  try {
    // 1. Search form: gets the anti-forgery cookies and the hidden token.
    const formRes = await go(SEARCH_URL, { method: 'GET' }, jar);
    storeCookies(formRes, jar);
    const formHtml = await formRes.text();
    if (formRes.status === 403 || formRes.status === 429) return out('couldnt_check', 'blocked', SEARCH_URL, `HTTP ${formRes.status}`);
    if (!formRes.ok) return out('couldnt_check', 'http_error', SEARCH_URL, `HTTP ${formRes.status}`);
    const tokenTag = formHtml.match(/<input[^>]*AntiforgeryFieldname[^>]*>/i)?.[0] || '';
    const token = tokenTag.match(/value="([^"]*)"/i)?.[1];
    if (!token || !/name="searchTerm"/i.test(formHtml)) {
      return out('couldnt_check', 'layout_changed', SEARCH_URL, formHtml.slice(0, 300));
    }

    // 2. Submit the search. The site answers with a redirect to the results address.
    if (Date.now() - started > BUDGET_MS) return out('couldnt_check', 'timeout', SEARCH_URL, 'time budget used');
    stage = 'search post';
    const body = new URLSearchParams({ searchTerm, AntiforgeryFieldname: token });
    const postRes = await go(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': SEARCH_URL, 'Origin': BASE },
      body: body.toString(),
      redirect: 'manual',
    }, jar);
    storeCookies(postRes, jar);
    await postRes.text().catch(() => '');
    if (postRes.status === 403 || postRes.status === 429) return out('couldnt_check', 'blocked', SEARCH_URL, `HTTP ${postRes.status}`);
    const loc = postRes.headers.get('location');
    if (postRes.status >= 400) return out('couldnt_check', 'http_error', SEARCH_URL, `HTTP ${postRes.status}`);
    if (!(postRes.status >= 300 && postRes.status < 400) || !loc) {
      return out('couldnt_check', 'layout_changed', SEARCH_URL, `search answered HTTP ${postRes.status} without a results redirect`);
    }
    const firstUrl = new URL(loc, BASE).href;
    if (!/\/eiir\/search-results\//i.test(firstUrl)) {
      return out('couldnt_check', 'layout_changed', firstUrl, 'redirect is not a results page');
    }

    // 3. Read the result pages. Each page holds 10 records; a company match can be on any page.
    stage = 'results';
    const matches = [];
    let total = 0, pageSize = 10, pagesTotal = 1, pagesDone = 0, excerpt = '';
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > BUDGET_MS) break;
      if (page > pagesTotal) break;
      const url = page === 1 ? firstUrl : `${firstUrl.replace(/\/$/, '')}/${page}/`;
      if (page > 1 && Date.now() - started > BUDGET_MS) break;
      const res = await fetchResultsPage(url, jar);
      if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return out('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
      const html = res.html;
      const p = parsePage(html);
      if (page === 1) {
        if (p.kind === 'none') {
          return out('not_found', '', firstUrl, `Search for "${term}" returned no records: ${decode(html.match(/find any results[^<]*/i)?.[0] || 'no results')}`);
        }
        if (p.kind !== 'records' || (p.rows.length === 0 && p.total > 0)) {
          return out('couldnt_check', 'layout_changed', firstUrl, html.slice(0, 300));
        }
        total = p.total;
        pageSize = p.rows.length || 10;
        pagesTotal = Math.max(1, Math.ceil(total / pageSize));
        excerpt = `Search returned ${total} records`;
      } else {
        if (p.kind !== 'records' || p.rows.length === 0) {
          return out('couldnt_check', 'layout_changed', url, `results page ${page} is not as expected`);
        }
      }
      pagesDone = page;
      for (const row of p.rows) {
        for (const t of row.trading) {
          if (sameName(t.name, term)) {
            matches.push({
              name: row.name,
              trading_name: t.name,
              trading_address: t.address,
              postcode: row.postcode,
              case_url: row.case_url,
            });
          }
        }
      }
      if (page >= pagesTotal) break;
    }

    const complete = pagesDone >= pagesTotal;
    if (matches.length) {
      const note = complete ? '' : `; checked ${pagesDone} of ${pagesTotal} result pages, the rest were not checked`;
      return out('found', '', firstUrl,
        `Trading name "${matches[0].trading_name}" matches on ${matches.length} record(s) of ${total} individual records${note}`,
        matches);
    }
    if (complete) {
      return out('not_found', '', firstUrl, `${excerpt}; none of them has a trading name matching "${term}"`);
    }
    return out('couldnt_check', 'timeout', firstUrl,
      `checked ${pagesDone} of ${pagesTotal} result pages (${total} records), no match yet; time budget used`);
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return out('couldnt_check', reason, SEARCH_URL, `${stage}: ${String(err?.message || err)}`);
  }
}
