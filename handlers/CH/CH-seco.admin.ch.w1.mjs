export const meta = {
  task: 'CH-seco.admin.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'addressee_type', 'sanctions_program', 'match_quality', 'detail_url'],
  canary: { found: 'Altrum Group FZCO', not_found: 'Schreinerei Zwirnhaus Beispiel AG' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.sesam.search.admin.ch';
const PAGE = `${BASE}/sesam-search-web/pages/search.xhtml?theme=new&lang=de`;

// Legal-form words, removed only at the start or end of a name (so "JSC Ryazan Oil" and "Ryazan Oil Ltd" both become "ryazanoil").
const LEGAL = new Set(['llc', 'ltd', 'limited', 'jsc', 'pjsc', 'ojsc', 'cjsc', 'ooo', 'oao', 'zao', 'pao', 'gmbh', 'ag',
  'sa', 'sarl', 'srl', 'spa', 'bv', 'nv', 'kg', 'kgaa', 'co', 'corp', 'inc', 'plc', 'llp', 'lp', 'fzco', 'fze', 'fzc',
  'fz', 'fzllc', 'sdn', 'bhd', 'pte', 'pty', 'ab', 'as', 'oy', 'sro', 'ltda', 'ug', 'eg', 'ev']);

function normalise(str) {
  let t = (str || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let tokens = t ? t.split(' ') : [];
  while (tokens.length > 1 && LEGAL.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = PAGE;
  const kw = (keyword || '').replace(/\s+/g, ' ').trim();
  try {
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'empty keyword' };

    // Step 1: open the search page to get the JSF session cookie, the view state and the form action.
    const getRes = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (getRes.status === 403 || getRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${getRes.status} on search page` };
    }
    if (!getRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${getRes.status} on search page` };
    }
    const cookies = cookieHeader(getRes);
    const pageHtml = await getRes.text();
    const vsMatch = pageHtml.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/i);
    if (!vsMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: decode(pageHtml).slice(0, 300) };
    }
    const actionMatch = pageHtml.match(/<form[^>]*id="pollForm"[^>]*action="([^"]+)"/i);
    const postUrl = actionMatch ? new URL(actionMatch[1].replace(/&amp;/g, '&'), BASE).href : PAGE;
    const versionMatch = pageHtml.match(/name="Applikations-Version"[^>]*value="([^"]+)"/i);

    // Step 2: post the name search, the same request the page's own "Suchen" button sends.
    const form = new URLSearchParams();
    form.set('pollForm', 'pollForm');
    form.set('lang', 'de');
    form.set('theme', 'new');
    if (versionMatch) form.set('Applikations-Version', versionMatch[1]);
    form.set('nameNamensteile', kw);
    form.set('volltextsuche', '');
    form.set('action', 'searchAction');
    form.set('javax.faces.ViewState', vsMatch[1]);

    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookies ? { 'Cookie': cookies } : {}),
      },
      body: form.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${postRes.status} on search` };
    }
    if (!postRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${postRes.status} on search` };
    }
    const html = await postRes.text();
    if (/captcha/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: 'captcha on search result' };
    }

    const noHits = html.includes('Keine Treffer gefunden');
    const table = html.match(/<table[^>]*class="trefferliste"[\s\S]*?<\/table>/i);
    if (!table && !noHits) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: decode(html).slice(0, 300) };
    }

    // Step 3: keep only the rows whose normalised name is the same company as the one asked for.
    const rows = table ? (table[0].match(/<tr class="trefferlisteRow_\d+"[\s\S]*?<\/tr>/g) || []) : [];
    const want = normalise(kw) || kw.toLowerCase();
    const seen = [];
    const records = [];
    for (const row of rows) {
      const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
      if (cells.length < 4) continue;
      const linkMatch = cells[0].match(/<a[^>]*href="([^"]+)"/i);
      const name = decode(cells[0]);
      if (!name) continue;
      seen.push(name);
      const got = normalise(name) || name.toLowerCase();
      if (got !== want) continue;
      records.push({
        name,
        addressee_type: decode(cells[1]),
        sanctions_program: decode(cells[2]),
        match_quality: decode(cells[3]),
        detail_url: linkMatch ? new URL(linkMatch[1].replace(/&amp;/g, '&'), BASE).href : '',
      });
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: `SESAM name search "${kw}": ${records.map((r) => `${r.name} | ${r.addressee_type} | ${r.sanctions_program}`).join(' ; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: noHits
        ? `SESAM name search "${kw}": Keine Treffer gefunden`
        : `SESAM name search "${kw}": ${seen.length} result(s), none is this company (e.g. ${seen.slice(0, 3).join(' ; ')})`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
