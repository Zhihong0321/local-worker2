export const meta = { task: 'AR-comprar.gob.ar', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'cuit', 'ente_number', 'status', 'pre_registration_date'],
  canary: { found: 'FELSAN SRL', not_found: 'Sociedad Inexistente Zqxw SRL' } };

// COMPR.AR public supplier search (SIPRO): an ASP.NET page. Step 1 GET the search page (keeps its session cookies),
// step 2 POST the advanced search ("Razón social" field + the "Buscar" postback) with the page's ViewState.
const START_URL = 'https://comprar.gob.ar/PLIEGO/BuscarProveedorCiudadano.aspx';
const SEARCH_BUTTON = 'ctl00$CPH1$UCBuscarProveedor$btnBusquedaAvanzada';
const NAME_FIELD = 'ctl00$CPH1$UCBuscarProveedor$txtRazonSocial';
const GRID_ID = 'ctl00_CPH1_UCBuscarProveedor_gvResultados';
const PAGE_MARK = 'UCBuscarProveedor_txtRazonSocial';
const RESULT_MARK = 'UCBuscarProveedor_lblRegistrosEncontrados';
const ROW_CAP = 10; // the site returned at most 10 rows in every test
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['SA', 'SRL', 'SAS', 'SACI', 'SACIF', 'SAIC', 'SAICYF', 'SCA', 'SCS', 'SH', 'SNC', 'SC',
  'LTDA', 'EIRL', 'ANONIMA', 'LIMITADA', 'SOCIEDAD', 'RESPONSABILIDAD', 'COMANDITA']);

/** Case, accents, punctuation and legal-form words removed: "Felsan S.R.L." and "FELSAN SRL" both become "FELSAN". */
function normalizeName(str) {
  const s = String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[.'`’-]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ');
  return s.split(' ').filter((w) => w && !LEGAL_FORMS.has(w)).join('');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function hiddenValue(html, name) {
  const tag = html.match(new RegExp('<input[^>]*\\b(?:id|name)="' + name + '"[^>]*>'));
  if (!tag) return null;
  const v = tag[0].match(/\bvalue="([^"]*)"/);
  return v ? v[1] : '';
}

function result(status, reason, url, excerpt, records = []) {
  return { status, reason, records, source_url: url, excerpt: String(excerpt || '').slice(0, 500) };
}

function statusProblem(res, url) {
  if (res.status === 403 || res.status === 429) return result('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
  if (!res.ok) return result('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
  return null;
}

function remaining(deadline) {
  return Math.max(1000, Math.min(25000, deadline - Date.now()));
}

function absorbCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/** One request, following redirects by hand so the cookies the site sets are kept. */
async function send(url, opts, jar, deadline) {
  let current = url;
  let method = opts.method;
  let body = opts.body;
  let extra = opts.headers || {};
  for (let hop = 0; hop < 6; hop++) {
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.5', ...extra };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(current, { method, body, headers, redirect: 'manual',
      signal: AbortSignal.timeout(remaining(deadline)) });
    absorbCookies(res, jar);
    const text = await res.text();
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      method = 'GET';
      body = undefined;
      extra = {};
      continue;
    }
    return { res, text, url: current };
  }
  throw new Error('too many redirects');
}

function parseRows(html) {
  const start = html.indexOf(`id="${GRID_ID}"`);
  if (start < 0) return [];
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end > start ? end : undefined);
  const rows = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    if (!tr.includes('lblNumeroCUITCUIL')) continue; // header row has no such span
    const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cleanText);
    if (cells.length < 4) continue;
    rows.push({ name: cells[2], cuit: cells[0], ente_number: cells[1], status: cells[3],
      pre_registration_date: cells[4] || '' });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + 55000;
  const jar = new Map();
  let pageUrl = START_URL;
  try {
    const name = String(keyword || '').replace(/\s+/g, ' ').trim();
    if (!name) return result('couldnt_check', 'other', START_URL, 'empty company name');

    // Step 1: the search page, for its ViewState
    const page = await send(START_URL, { method: 'GET' }, jar, deadline);
    pageUrl = page.url;
    const problem = statusProblem(page.res, pageUrl);
    if (problem) return problem;
    const html = page.text;
    const viewState = hiddenValue(html, '__VIEWSTATE');
    if (viewState === null || !html.includes(PAGE_MARK)) {
      const reason = /captcha|access denied|cloudflare/i.test(html) ? 'blocked' : 'layout_changed';
      return result('couldnt_check', reason, pageUrl, cleanText(html).slice(0, 300));
    }

    // Step 2: the advanced search postback
    const form = new URLSearchParams();
    form.set('__EVENTTARGET', SEARCH_BUTTON);
    form.set('__EVENTARGUMENT', '');
    form.set('__VIEWSTATE', viewState);
    const gen = hiddenValue(html, '__VIEWSTATEGENERATOR');
    if (gen !== null) form.set('__VIEWSTATEGENERATOR', gen);
    const ev = hiddenValue(html, '__EVENTVALIDATION');
    if (ev !== null) form.set('__EVENTVALIDATION', ev);
    // the site matches the typed text literally, so "S.R.L." must go as "SRL" (the stored form)
    form.set(NAME_FIELD, name.replace(/[.'`’]/g, ''));

    const post = await send(pageUrl, { method: 'POST', body: form.toString(), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Referer': pageUrl, 'Origin': 'https://comprar.gob.ar' } },
    jar, deadline);
    pageUrl = post.url;
    const postProblem = statusProblem(post.res, pageUrl);
    if (postProblem) return postProblem;
    const out = post.text;
    if (!out.includes(RESULT_MARK) || !out.includes(PAGE_MARK)) {
      const reason = /captcha|access denied|cloudflare/i.test(out) ? 'blocked' : 'layout_changed';
      return result('couldnt_check', reason, pageUrl, cleanText(out).slice(0, 300));
    }

    const records = parseRows(out);
    const kw = normalizeName(name);
    const matches = kw ? records.filter((r) => normalizeName(r.name) === kw) : [];
    if (matches.length) {
      return { status: 'found', reason: '', records: matches, source_url: pageUrl,
        excerpt: matches.map((r) => `${r.name} | CUIT ${r.cuit} | ${r.status}`).join(' ; ').slice(0, 500) };
    }
    if (records.length >= ROW_CAP) {
      return result('couldnt_check', 'other', pageUrl,
        `${records.length} rows returned and none has this exact name; the list may be cut off`);
    }
    return result('not_found', '', pageUrl, records.length
      ? `only similar names: ${records.map((r) => r.name).join('; ')}`
      : `0 rows on the supplier search for "${name}"`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return result('couldnt_check', timeout ? 'timeout' : 'other', pageUrl, String(err?.message || err));
  }
}
