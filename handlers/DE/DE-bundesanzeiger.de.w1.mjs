export const meta = {
  task: 'DE-bundesanzeiger.de',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'location', 'publication', 'part', 'date'],
  canary: { found: 'Siemens Aktiengesellschaft', not_found: 'Zerflumpte Gelbe Vogelscheuche GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.bundesanzeiger.de';
const FORM_PAGE = BASE + '/pub/de/suche-gesellschaftsbekanntmachungen';
const FORM_ACTION = FORM_PAGE + '?0-1.-search~form~panel-search~form';
const MAX_PAGES = 6;
const TIME_BUDGET_MS = 40000;

// Legal-form words that are dropped before comparing names (AG = Aktiengesellschaft, GmbH, ...).
const LEGAL = new Set(['aktiengesellschaft', 'ag', 'se', 'gmbh', 'ug', 'kg', 'kgaa', 'ohg', 'mbh', 'eg', 'ev',
  'haftungsbeschraenkt', 'beschraenkter', 'haftung', 'co']);

function normalize(str) {
  const words = (str || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.filter((w) => !LEGAL.has(w)).join('');
}

function clean(html) {
  return (html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

function cookieHeader(res, prev) {
  const jar = new Map();
  for (const part of (prev || '').split('; ').filter(Boolean)) {
    const [k, ...v] = part.split('=');
    jar.set(k, v.join('='));
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const pair = sc.split(';')[0];
    const [k, ...v] = pair.split('=');
    if (k) jar.set(k.trim(), v.join('='));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseRows(html) {
  const rows = [];
  const chunks = html.split(/<div class="row(?: back)?">/).slice(1);
  for (const chunk of chunks) {
    const first = chunk.match(/<div class="first">([\s\S]*?)<\/div>/);
    const info = chunk.match(/<div class="info">([\s\S]*?)<\/div>/);
    const date = chunk.match(/<div class="date">([\s\S]*?)<\/div>/);
    const part = chunk.match(/<div class="part">([\s\S]*?)<\/div>/);
    if (!first || !info) continue;
    const nameParts = first[1].split(/<br\s*\/?>/i).map(clean).filter(Boolean);
    const linkText = info[1].match(/<a[^>]*>([\s\S]*?)<\/a>/);
    rows.push({
      name: nameParts[0] || '',
      location: nameParts.slice(1).join(', '),
      publication: linkText ? clean(linkText[1]) : clean(info[1]),
      part: part ? clean(part[1]) : '',
      date: date ? clean(date[1]) : '',
    });
  }
  return rows;
}

function totalHits(html) {
  const m = html.match(/Alle Bereiche \((\d+) Treffer\)/);
  return m ? Number(m[1]) : null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let searchUrl = FORM_ACTION;
  try {
    // 1) Open the search form to get a session cookie.
    const formRes = await fetch(FORM_PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (formRes.status === 403 || formRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: FORM_PAGE, excerpt: `HTTP ${formRes.status}` };
    }
    if (!formRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: FORM_PAGE, excerpt: `HTTP ${formRes.status}` };
    }
    let cookies = cookieHeader(formRes, '');
    const formHtml = await formRes.text();
    if (/captcha/i.test(formHtml)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: FORM_PAGE, excerpt: 'captcha on form page' };
    }
    if (!formHtml.includes('name="company"') || !formHtml.includes('search~form~panel-search~form')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: FORM_PAGE, excerpt: formHtml.slice(0, 300) };
    }

    // 2) Submit the search (both the keyword box and the company box, as the form does).
    const body = new URLSearchParams({ fulltext: keyword, company: keyword, 'search-button': 'Suchen' }).toString();
    const postRes = await fetch(FORM_ACTION, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': FORM_PAGE,
        'Cookie': cookies,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });
    cookies = cookieHeader(postRes, cookies);
    searchUrl = postRes.url || FORM_ACTION;
    if (postRes.status === 403 || postRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${postRes.status}` };
    }
    if (!postRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${postRes.status}` };
    }
    let html = await postRes.text();
    if (!html.includes('Ergebnisse für Suchbegriff')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: clean(html).slice(0, 300) };
    }

    // 3) Read result rows; follow the "next" pager link while more hits remain (max MAX_PAGES pages).
    const total = totalHits(html);
    const all = [];
    let pages = 0;
    for (;;) {
      pages += 1;
      all.push(...parseRows(html));
      const next = html.match(/href="([^"]*nav-pager-next[^"]*)"/);
      if (!next || pages >= MAX_PAGES) break;
      if (Date.now() - started > TIME_BUDGET_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: 'paging stopped near the 60 s limit' };
      }
      const nextUrl = new URL(next[1].replace(/&amp;/g, '&'), BASE).href;
      const nextRes = await fetch(nextUrl, {
        headers: { 'User-Agent': UA, 'Cookie': cookies, 'Referer': searchUrl, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (!nextRes.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: nextUrl, excerpt: `HTTP ${nextRes.status}` };
      }
      cookies = cookieHeader(nextRes, cookies);
      html = await nextRes.text();
    }

    const want = normalize(keyword);
    const matches = all.filter((r) => want && normalize(r.name) === want);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: searchUrl,
        excerpt: `${matches.length} publication(s) for ${matches[0].name} (${matches[0].location}); site total ${total ?? 'unknown'} hits`,
      };
    }

    // No match. Only "not_found" if every hit the site reports was read.
    if (all.length === 0 || total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 Treffer for ${keyword}` };
    }
    if (total !== null && all.length >= total) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `${all.length} of ${total} hits read, none named ${keyword}` };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: `read ${pages} page(s), ${all.length} of ${total ?? 'unknown'} hits; no exact name match yet`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
