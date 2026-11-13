export const meta = {
  task: 'IN-ibbi.gov.in',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cin', 'process_initiated', 'sector', 'processes'],
  canary: { found: 'TATA STEEL INTERNATIONAL (INDIA) LIMITED', not_found: 'Zyqorvex Phantom Holdings Private Limited' },
};

// Flow the public "Corporate Processes" page uses (ibbi.gov.in/claims/corporate-personals):
//  1. GET the page: sets a session cookie and a form token (_csrfToken).
//  2. GET /claims/get-cinnum?name=...   -> the site's name suggestions (the list it shows while typing).
//  3. GET /claims/get-cinnum?finalname=... -> the CIN for the chosen name.
//  4. POST the form (fieldname, cin_no, cirpprcs=1) -> 302 to /claims/inner-process/<CIN>, the detail page.

const BASE = 'https://ibbi.gov.in';
const PAGE = BASE + '/claims/corporate-personals';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_WORDS = new Set(['limited', 'ltd', 'private', 'pvt', 'llp']);
const LEGAL_RE = /\b(limited|ltd|private|pvt|llp)\b\.?/gi;

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Name with case, punctuation and legal form removed, so "Tata Steel Limited" equals "TATA STEEL LTD." */
function core(s) {
  return decode(s).normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(/\s+/).filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Name suggestions: [] when the site says 0 / nothing, null when the answer is not the list we expect. */
function parseSuggestions(body) {
  const t = body.trim();
  if (t === '' || t === '0') return [];
  const names = [...t.matchAll(/<a\b[^>]*class="dropdown-item"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => clean(m[1])).filter(Boolean);
  return names.length ? names : null;
}

/** Detail page: the "Details About CD" table plus each "Professionals Associated" block. */
function parseDetail(html) {
  const rows = {};
  for (const r of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]));
    if (cells.length === 2) {
      const label = cells[0].replace(/:$/, '');
      if (label && !(label in rows)) rows[label] = cells[1];
    }
  }
  const processes = [];
  for (const block of html.split(/<div class="pro">/i).slice(1)) {
    const note = clean((block.match(/<div class="processbx">([\s\S]*?)<\/div>/i) || [])[1] || '');
    const professionals = [];
    for (const r of block.split('</table>')[0].split(/<tr[\s>]/i).slice(1)) {
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]));
      if (cells.length >= 3 && cells[0] && cells[1]) {
        professionals.push({ name: cells[0], registration_no: cells[1], appointed_as: cells[2] });
      }
    }
    processes.push({ process_note: note, professionals });
  }
  if (!rows['Name of the Corporate Debtor']) return null;
  return {
    name: rows['Name of the Corporate Debtor'],
    cin: rows['CIN No'] || '',
    process_initiated: rows['Process Initiated'] || '',
    sector: rows['Sector of business of CD'] || '',
    processes,
  };
}

function jar(res, cookies) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const map = new Map(cookies);
  for (const c of raw) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return map;
}

async function call(url, init, cookies) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': PAGE,
    ...(init.headers || {}),
  };
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  return fetch(url, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const tooLate = () => Date.now() - t0 > 30000; // each fetch may take 25 s, so no new fetch after 30 s
  const kw = String(keyword || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const query = kw.replace(LEGAL_RE, ' ').replace(/\s+/g, ' ').replace(/[\s.,]+$/, '').trim();
  const kc = core(kw);
  if (!kc) return fail('other', PAGE, 'the keyword has no company name in it');
  if (query.length < 3) return fail('other', PAGE, 'the site search needs at least 3 characters');

  let cookies = new Map();
  try {
    // 1. Form page: session cookie + token.
    const r1 = await call(PAGE, { method: 'GET' }, cookies);
    if (r1.status === 403 || r1.status === 429) return fail('blocked', PAGE, `HTTP ${r1.status}`);
    if (!r1.ok) return fail('http_error', PAGE, `HTTP ${r1.status}`);
    cookies = jar(r1, cookies);
    const h1 = await r1.text();
    const token = (h1.match(/name="_csrfToken" value="([^"]+)"/) || [])[1];
    if (!token || !/Corporate Debtor Name/.test(h1)) return fail('layout_changed', PAGE, clean(h1));

    // 2. Name suggestions.
    const sugUrl = BASE + '/claims/get-cinnum?' + new URLSearchParams({ name: query });
    if (tooLate()) return fail('timeout', sugUrl, 'the handler ran out of its time budget');
    const r2 = await call(sugUrl, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }, cookies);
    if (r2.status === 403 || r2.status === 429) return fail('blocked', sugUrl, `HTTP ${r2.status}`);
    if (!r2.ok) return fail('http_error', sugUrl, `HTTP ${r2.status}`);
    const sugs = parseSuggestions(await r2.text());
    if (sugs === null) return fail('layout_changed', sugUrl, 'suggestion list is not in the expected form');
    const hit = sugs.find((n) => core(n) === kc);
    if (!hit) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sugUrl,
        excerpt: sugs.length
          ? `No exact match for "${kw}". Similar names listed: ${sugs.slice(0, 5).join('; ')}`
          : `The site lists no corporate debtor for "${query}"`,
      };
    }

    // 3. CIN for the matched name.
    const cinUrl = BASE + '/claims/get-cinnum?' + new URLSearchParams({ finalname: hit });
    if (tooLate()) return fail('timeout', cinUrl, 'the handler ran out of its time budget');
    const r3 = await call(cinUrl, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }, cookies);
    if (r3.status === 403 || r3.status === 429) return fail('blocked', cinUrl, `HTTP ${r3.status}`);
    if (!r3.ok) return fail('http_error', cinUrl, `HTTP ${r3.status}`);
    const cin = (await r3.text()).trim();
    if (!/^[A-Z0-9]{8,25}$/i.test(cin)) return fail('other', cinUrl, `the site gave no CIN for "${hit}": ${cin.slice(0, 80)}`);

    // 4. The form POST, then the redirect to the detail page.
    if (tooLate()) return fail('timeout', PAGE, 'the handler ran out of its time budget');
    const body = new URLSearchParams({ _csrfToken: token, fieldname: hit, cin_no: cin, cirpprcs: '1' });
    const r4 = await call(PAGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': BASE },
      body,
    }, cookies);
    if (r4.status === 403 || r4.status === 429) return fail('blocked', PAGE, `HTTP ${r4.status}`);
    if (!r4.ok) return fail('http_error', PAGE, `HTTP ${r4.status}`);
    const detailUrl = r4.url;
    const h4 = await r4.text();
    if (!/\/claims\/inner-process\//.test(detailUrl)) return fail('layout_changed', detailUrl, clean(h4));

    const d = parseDetail(h4);
    if (!d) return fail('layout_changed', detailUrl, clean(h4));
    if (core(d.name) !== kc) return fail('other', detailUrl, `the site returned "${d.name}" for "${hit}"`);

    const i = h4.indexOf('sv-tab-panel');
    return {
      status: 'found',
      reason: '',
      records: [{ name: d.name, cin: d.cin, process_initiated: d.process_initiated, sector: d.sector, processes: d.processes }],
      source_url: detailUrl,
      excerpt: clean(i >= 0 ? h4.slice(i, i + 4000) : h4).slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', PAGE, String((err && err.message) || err));
  }
}
