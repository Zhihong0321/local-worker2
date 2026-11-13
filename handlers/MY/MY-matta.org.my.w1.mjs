export const meta = { task: 'MY-matta.org.my', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'registration_no', 'membership_no', 'phone', 'website', 'address', 'detail_url'],
  canary: { found: 'AA Aviation Sdn Bhd', not_found: 'Syarikat Pelancongan Tiada Rekod Sdn Bhd' } };

// MATTA member directory: https://matta.org.my/members is an ASP.NET form. A GET returns the page with its hidden
// tokens (__VIEWSTATE, __EVENTVALIDATION); a POST of the same form with the company name returns the result list.
const DIRECTORY = 'https://matta.org.my/members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ALL_STATES = '00000000-0000-0000-0000-000000000000';

function headers(extra = {}) {
  return { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9', ...extra };
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  const t = decodeEntities((html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/(\s*,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return t === '-' ? '' : t;
}

/** Normalised company name: case, punctuation, '&' and the common legal-form spellings (Sdn. Bhd. / Berhad). */
function normName(s) {
  return decodeEntities(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bsendirian\s+berhad\b/g, 'sdn bhd')
    .replace(/\bberhad\b/g, 'bhd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** The directory search matches the name text, so send the name without the legal form; matching is done afterwards. */
function searchTerm(keyword) {
  const core = keyword.replace(/\s+/g, ' ').trim()
    .replace(/[\s,.]*\b(sdn\.?\s*bhd\.?|sendirian\s+berhad|berhad|bhd\.?)\s*\.?$/i, '').trim();
  return core || keyword.trim();
}

function readHidden(html) {
  const hidden = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = m[0].match(/\bname="([^"]+)"/)?.[1];
    const value = m[0].match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    if (name && name.startsWith('__')) hidden[name] = decodeEntities(value);
  }
  return hidden;
}

function cookieHeader(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return raw.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function parseResults(html) {
  const start = html.search(/Search Results/i);
  const body = start >= 0 ? html.slice(start) : html;
  return body.split(/<div class="card-box">/i).slice(1).map((chunk) => {
    const card = chunk.split(/<footer/i)[0];
    const t = card.match(/<a href="(\/member\/[^"]+)" class="search-title">([\s\S]*?)<\/a>\s*<span class="reg-number">([\s\S]*?)<\/span>/i);
    if (!t) return null;
    const reg = cleanText(t[3]).split('|').map((s) => s.trim());
    const field = (cls) => cleanText(card.match(new RegExp(`class="icon-label ${cls}"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'))?.[1]);
    return {
      name: cleanText(t[2]),
      registration_no: reg[0] || '',
      membership_no: reg[1] || '',
      phone: field('contact-number'),
      website: field('web-address'),
      address: field('location'),
      detail_url: new URL(t[1], DIRECTORY).href,
      text: cleanText(card).slice(0, 500),
    };
  }).filter(Boolean);
}

function looksBlocked(html) {
  return /captcha|cf-chl|challenge-platform|Just a moment|Access denied|Attention Required/i.test(html);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const fail = (reason, excerpt, source_url = DIRECTORY) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });
  if (!kw) return fail('other', 'empty company name');
  try {
    // 1. Open the directory form: keeps the session cookie and the hidden tokens the form needs.
    const getRes = await fetch(DIRECTORY, { headers: headers(), signal: AbortSignal.timeout(25000) });
    const getHtml = await getRes.text();
    if (getRes.status === 403 || getRes.status === 429) return fail('blocked', `HTTP ${getRes.status}`);
    if (!getRes.ok) return fail('http_error', `HTTP ${getRes.status}`);
    const formOk = /ctl00\$body\$txt_search/.test(getHtml) && /__VIEWSTATE/.test(getHtml);
    if (!formOk) return fail(looksBlocked(getHtml) ? 'blocked' : 'layout_changed', getHtml.slice(0, 300));
    const hidden = readHidden(getHtml);
    if (!hidden.__VIEWSTATE) return fail('layout_changed', 'no __VIEWSTATE on the directory page');
    const cookie = cookieHeader(getRes);

    // 2. Post the search form, the way the browser does when the Search button is pressed.
    const form = new URLSearchParams({
      ...hidden,
      '__EVENTTARGET': '',
      '__EVENTARGUMENT': '',
      'ctl00$body$txt_search': searchTerm(kw),
      'ctl00$body$ddl_license': 'all',
      'ctl00$body$ddl_state': ALL_STATES,
      'ctl00$body$btn_search': 'Search',
    });
    const postRes = await fetch(DIRECTORY, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://matta.org.my', 'Referer': DIRECTORY, ...(cookie ? { Cookie: cookie } : {}) }),
      body: form.toString(),
      signal: AbortSignal.timeout(25000),
    });
    const html = await postRes.text();
    if (postRes.status === 403 || postRes.status === 429) return fail('blocked', `HTTP ${postRes.status}`);
    if (!postRes.ok) return fail('http_error', `HTTP ${postRes.status}`);

    // 3. Read the result count and the result cards.
    const countMatch = html.match(/Search Results\s*\(\s*(\d+)\s+matching results?\s+found\s*\)/i);
    if (!countMatch) return fail(looksBlocked(html) ? 'blocked' : 'layout_changed', html.slice(0, 300));
    const total = Number(countMatch[1]);
    const cards = parseResults(html);
    if (total > 0 && cards.length === 0) return fail('layout_changed', `count ${total} but no result cards`);
    if (cards.length < total) return fail('other', `directory returned ${cards.length} of ${total} results; company not in the shown part`);

    // 4. Match the company itself, by normalised name.
    const want = normName(kw);
    const matches = cards.filter((c) => normName(c.name) === want);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ text, ...rec }) => rec),
        source_url: DIRECTORY,
        excerpt: matches[0].text,
      };
    }
    // The site answered normally and the company is not in its list (0 results, or only similar names).
    const near = cards.slice(0, 3).map((c) => c.name).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: DIRECTORY,
      excerpt: total === 0 ? 'Search Results (0 matching results found)' : `Search Results (${total} matching results found), none with this name. Shown: ${near}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
