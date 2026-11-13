export const meta = { task: 'AU-chambernt.com.au', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'registered_name', 'abn', 'location', 'employees', 'year_founded'],
  canary: { found: 'NQ All Terrain Hire', not_found: 'Zyxwv Qorbel Trading Pty Ltd' } };

// Chamber of Commerce NT member directory (ASP.NET WebForms). The name search is a normal postback that needs the
// page's hidden fields and the session cookie from the first GET. The search matches TRADING names only (substring,
// case-insensitive), so the legal form is removed before searching and the rows are compared after normalising.
const DIR = 'https://www.chambernt.com.au/Web/Business-Directory/Business-Directory.aspx';
const DETAIL = 'https://www.chambernt.com.au/Web/Business-Directory/Business-Directory-Detail.aspx?CK=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TEXTBOX = 'ctl01$TemplateBody$WebPartManager1$gwpciDirectory1$ciDirectory1$ResultsGrid$Sheet0$Input0$TextBox1';
const SUBMIT = 'ctl01$TemplateBody$WebPartManager1$gwpciDirectory1$ciDirectory1$ResultsGrid$Sheet0$SubmitButton';
const LAST_CLICKED = 'ctl01_TemplateBody_WebPartManager1_gwpciDirectory1_ciDirectory1_ResultsGrid_Sheet0_SubmitButton';
const LEGAL = new Set(['pty', 'proprietary', 'ltd', 'limited', 'inc', 'incorporated']);

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Words of a name, lower-case, '&' as 'and', trailing legal-form words removed. */
function nameWords(name) {
  const w = clean(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"', 'i'));
  return m ? decode(m[1]) : null;
}

function headers(extra) {
  return { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...extra };
}

function looksBlocked(text) {
  return /captcha|cf-challenge|just a moment|attention required|access denied/i.test(text || '');
}

function failure(err) {
  const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: DIR,
           excerpt: String(err?.message || err).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (typeof keyword !== 'string' || !keyword.trim()) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIR, excerpt: 'empty company name' };
    }
    // Search text: the name as typed, without trailing legal-form words (they break the trading-name search).
    const words = keyword.trim().split(/\s+/);
    while (words.length && LEGAL.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
    const searchTerm = words.join(' ');
    const key = nameWords(keyword).join('');
    if (!searchTerm || !key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIR, excerpt: 'no company name left after removing the legal form' };
    }
    const t0 = Date.now();

    // Step 1: the directory page, for the hidden fields and the session cookie.
    const getRes = await fetch(DIR, { headers: headers(), signal: AbortSignal.timeout(25000) });
    if (getRes.status === 403 || getRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIR, excerpt: `HTTP ${getRes.status}` };
    }
    if (!getRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIR, excerpt: `HTTP ${getRes.status}` };
    }
    const page = await getRes.text();
    if (looksBlocked(page)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIR, excerpt: 'bot check or captcha on the directory page' };
    }
    if (!page.includes('ResultsGrid_Grid1') || !page.includes('name="__VIEWSTATE"')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIR, excerpt: page.slice(0, 300) };
    }
    const cookie = (getRes.headers.getSetCookie?.() || [])
      .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

    // Step 2: post the search the way the Find button does.
    const form = new URLSearchParams();
    for (const m of page.matchAll(/<input\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/type\s*=\s*"hidden"/i.test(tag)) continue;
      const n = attr(tag, 'name');
      if (n) form.set(n, attr(tag, 'value') ?? '');
    }
    form.set(TEXTBOX, searchTerm);
    form.set('__EVENTTARGET', SUBMIT);
    form.set('__EVENTARGUMENT', '');
    form.set('ctl01$lastClickedElementId', LAST_CLICKED);

    const postRes = await fetch(DIR, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': DIR, ...(cookie ? { Cookie: cookie } : {}) }),
      body: form.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIR, excerpt: `HTTP ${postRes.status} on search` };
    }
    if (!postRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIR, excerpt: `HTTP ${postRes.status} on search` };
    }
    const res = await postRes.text();
    if (looksBlocked(res)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIR, excerpt: 'bot check or captcha on the search' };
    }
    if (!res.includes('ResultsGrid_Grid1')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIR, excerpt: res.slice(0, 300) };
    }

    // Step 3: read the rows (name, location, detail link).
    const rows = [];
    for (const m of res.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = m[1];
      const ck = row.match(/Business-Directory-Detail\.aspx\?CK=([0-9A-Fa-f-]{36})/);
      if (!ck) continue;
      const h4 = row.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
      const loc = row.match(/<span class="location"[^>]*>([\s\S]*?)<\/span>/i);
      rows.push({ name: h4 ? clean(h4[1]) : '', location: loc ? clean(loc[1]) : '', ck: ck[1] });
    }

    const matches = rows.filter((r) => nameWords(r.name).join('') === key);

    if (!matches.length) {
      if (rows.length === 0 && !res.includes('rgNoRecords')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIR, excerpt: 'results grid has no rows and no "no records" marker' };
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: DIR,
        excerpt: `Directory search for "${searchTerm}" returned ${rows.length} row(s), none with this trading name. The directory search matches trading names only.`,
      };
    }

    // Step 4: the detail page of each match (ABN, registered name, employees, year founded). If it fails, the list row
    // still proves the match, so it is returned without the detail fields.
    const records = [];
    for (const r of matches) {
      const detailUrl = DETAIL + r.ck;
      const rec = { name: r.name, registered_name: '', abn: '', location: r.location, employees: '', year_founded: '' };
      if (Date.now() - t0 < 25000) {
        try {
          const dRes = await fetch(detailUrl, { headers: headers(cookie ? { Cookie: cookie } : {}), signal: AbortSignal.timeout(25000) });
          if (dRes.ok) {
            const det = await dRes.text();
            const pairs = {};
            for (const d of det.matchAll(/<div class="col-sm-5"><strong>([\s\S]*?)<\/strong><\/div>\s*<div class="col-sm-7">([\s\S]*?)<\/div>/gi)) {
              pairs[clean(d[1]).toLowerCase()] = clean(d[2]);
            }
            rec.name = pairs['trading name'] || r.name;
            rec.registered_name = pairs['registered name'] || '';
            rec.abn = pairs['abn'] || '';
            rec.employees = pairs['employees'] || '';
            rec.year_founded = pairs['year founded'] || '';
          }
        } catch (_) { /* keep the list row */ }
      }
      records.push(rec);
    }

    const excerpt = records.map((rec) => [
      `Trading Name: ${rec.name}`,
      rec.registered_name && `Registered Name: ${rec.registered_name}`,
      rec.abn && `ABN: ${rec.abn}`,
      rec.location && `Location: ${rec.location}`,
    ].filter(Boolean).join('; ')).join(' | ').slice(0, 500);

    return {
      status: 'found', reason: '', records, source_url: DETAIL + matches[0].ck, excerpt,
    };
  } catch (err) {
    return failure(err);
  }
}
