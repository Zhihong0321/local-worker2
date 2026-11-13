export const meta = { task: 'MY-skm.gov.my', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'state'], canary: { found: 'KOPERASI BIDOR BERHAD', not_found: 'Koperasi Tiada Rekod Fiktif Berhad' } };

const PAGE = 'https://dkoop.skm.gov.my/MakKopDaftar/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Legal-form words that the registry writes differently (BERHAD / BHD / SDN BHD / (M) ...). Dropped before comparing.
const LEGAL = new Set(['BERHAD', 'BHD', 'SDN', 'BND', 'LIMITED', 'LTD', 'M']);

function tokens(s) {
  return (s || '').toUpperCase().replace(/&amp;/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
/** Search text sent to the site: the name without legal-form words (the site matches a substring of the name). */
function searchText(keyword) {
  const core = tokens(keyword).filter((w) => !LEGAL.has(w));
  return (core.length ? core : tokens(keyword)).join(' ');
}
/** Comparison key: case, punctuation, spacing and legal form ignored. */
function nameKey(s) {
  return tokens(s).filter((w) => !LEGAL.has(w)).join('');
}
function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
function hiddenField(html, name) {
  const m = html.match(new RegExp('name="' + name + '"[^>]*value="([^"]*)"')) || html.match(new RegExp('id="' + name + '"[^>]*value="([^"]*)"'));
  return m ? m[1] : null;
}
function isBlocked(html) {
  return /TELAH DISEKAT|Access Denied/i.test(html);
}
function formFields(html) {
  const f = {
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    __VIEWSTATE: hiddenField(html, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hiddenField(html, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: hiddenField(html, '__EVENTVALIDATION'),
  };
  const nc = hiddenField(html, '__ncforminfo');
  if (nc !== null) f.__ncforminfo = nc;
  if (!f.__VIEWSTATE || !f.__EVENTVALIDATION) return null;
  return f;
}
function cookiesFrom(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return jar;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = (status, reason, records, excerpt) => ({
    status, reason, records, source_url: PAGE, excerpt: String(excerpt || '').slice(0, 500),
  });
  try {
    const input = String(keyword || '').trim();
    if (!tokens(input).length) return out('couldnt_check', 'other', [], 'empty company name');
    const query = searchText(input);
    const base = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ms-MY,ms;q=0.9,en;q=0.8' };

    // 1. Load the search page: it carries the ASP.NET form state and the session cookies.
    const jar = new Map();
    const g = await fetch(PAGE, { headers: base, signal: AbortSignal.timeout(25000) });
    if (g.status === 403 || g.status === 429) return out('couldnt_check', 'blocked', [], `HTTP ${g.status} on search page`);
    if (!g.ok) return out('couldnt_check', 'http_error', [], `HTTP ${g.status} on search page`);
    const gHtml = await g.text();
    cookiesFrom(g, jar);
    if (isBlocked(gHtml)) return out('couldnt_check', 'blocked', [], cleanText(gHtml).slice(0, 300));
    const fields = formFields(gHtml);
    if (!fields || !/id="txtNamaKoperasi"/.test(gHtml)) return out('couldnt_check', 'layout_changed', [], cleanText(gHtml).slice(0, 300));

    // 2. Submit the search (form POST, same as the Cari button).
    const body = new URLSearchParams({ ...fields, txtNamaKoperasi: query, carian: 'Cari' });
    const p = await fetch(PAGE, {
      method: 'POST',
      headers: {
        ...base,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://dkoop.skm.gov.my',
        'Referer': PAGE,
        ...(jar.size ? { 'Cookie': [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (p.status === 403 || p.status === 429) return out('couldnt_check', 'blocked', [], `HTTP ${p.status} on search`);
    if (!p.ok) return out('couldnt_check', 'http_error', [], `HTTP ${p.status} on search`);
    const html = await p.text();
    if (isBlocked(html)) return out('couldnt_check', 'blocked', [], cleanText(html).slice(0, 300));
    if (!/id="txtNamaKoperasi"/.test(html) || !/Berikut merupakan koperasi/i.test(html)) {
      return out('couldnt_check', 'layout_changed', [], cleanText(html).slice(0, 300));
    }

    // 3. Read the result grid: BIL. | NAMA KOPERASI | NEGERI
    const table = html.match(/<table[^>]*id="GridView1"[\s\S]*?<\/table>/i);
    const rows = table ? (table[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) : [];
    const items = [];
    for (const r of rows) {
      const cells = (r.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
      if (cells.length >= 3 && /^\d+$/.test(cells[0]) && cells[1]) {
        items.push({ name: cells[1], state: cells[2] });
      }
    }

    const target = nameKey(input);
    const matches = items.filter((it) => nameKey(it.name) === target);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((m) => ({ name: m.name, state: m.state })),
        source_url: PAGE,
        excerpt: `Search "${query}": ${items.length} row(s) on page 1. Matched: ${matches.map((m) => `${m.name} (${m.state})`).join('; ')}`,
      };
    }

    // No exact match on page 1. If the site has more pages, the handler cannot see them: do not call it not_found.
    if (/Page\$\d+/.test(html)) {
      return out('couldnt_check', 'other', [], `Search "${query}" has more than one page of results; no exact match on page 1 and the handler does not page through results`);
    }
    return out('not_found', '', [], `Search "${query}" returned ${items.length} row(s); none matches the name${items.length ? ': ' + items.slice(0, 5).map((i) => i.name).join('; ') : ''}`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], String(err && err.message ? err.message : err));
  }
}
