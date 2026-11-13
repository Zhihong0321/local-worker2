export const meta = {
  task: 'AR-contratar.gob.ar',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cuit', 'type', 'supplier_id'],
  canary: { found: 'CONSTRUCTORA SAN JOSE, S.A.', not_found: 'CONSTRUCCIONES FICTICIAS INEXISTENTES S.R.L.' },
};

// Source: "Buscar Constructor" popup on the public advanced-search page (BuscarAvanzado.aspx).
// It is an ASP.NET UpdatePanel postback: a session cookie from the site, the page's __VIEWSTATE,
// then one async POST with the name typed in the popup. The result is an HTML table, 3 rows per page; only the
// first page is read (later pages are not followed).
const BASE = 'https://contratar.gob.ar';
const DEFAULT_URL = `${BASE}/Default.aspx`;
const SEARCH_URL = `${BASE}/BuscarAvanzado.aspx`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BTN = 'ctl00$CPH1$devCbPnlPopupListarProveedor$btnListarProveedor';
const PANEL = 'ctl00$CPH1$devCbPnlPopupListarProveedor$uptPnlResultadoListarProveedor';
const NAME_FIELD = 'ctl00$CPH1$devCbPnlPopupListarProveedor$txtPopupNombreProveedor';
const CUIT_FIELD = 'ctl00$CPH1$devCbPnlPopupListarProveedor$txtPopupCuitProveedor';

// Legal-form words that are ignored when comparing names (trailing words only).
const LEGAL = new Set(['S', 'A', 'SA', 'SRL', 'R', 'L', 'SAS', 'SACI', 'SACIF', 'SAIC', 'SAICYF', 'SCA', 'SCS', 'LTDA', 'SAU', 'SH', 'SC']);

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function words(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

function fullKey(s) { return words(s).join(''); }

function coreKey(s) {
  const w = words(s);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join('');
}

// The keyword with trailing legal-form words removed, e.g. "ACME S.A." -> "ACME". The site matches the typed text
// as a substring, so "CONSTRUCTORA SAN JOSE, S.A." is not matched by "CONSTRUCTORA SAN JOSE SA"; the core is retried.
function coreText(s) {
  const t = String(s).trim().split(/[\s,.;]+/).filter(Boolean);
  while (t.length > 1 && LEGAL.has(words(t[t.length - 1]).join(''))) t.pop();
  return t.join(' ');
}

function isSameName(recordName, keyword) {
  const rk = fullKey(recordName);
  if (rk && rk === fullKey(keyword)) return true;
  const rc = coreKey(recordName);
  return rc.length > 0 && rc === coreKey(keyword);
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

function takeCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0];
    const name = kv.split('=')[0].trim();
    if (name) jar.set(name, kv);
  }
}

const cookieHeader = (jar) => [...jar.values()].join('; ');

// Parses one search result. Returns { total, rows } or throws { reason, excerpt } for a page we do not recognise.
function parseResults(text) {
  if (/\|error\|/i.test(text) || /\|pageRedirect\|/i.test(text)) throw { reason: 'blocked', excerpt: 'the site redirected or refused the search' };
  const label = text.match(/Se han encontrado \((\d+)\) resultados/);
  let total;
  if (label) total = Number(label[1]);
  else if (/No se han encontrado resultados/.test(text)) total = 0;
  else throw { reason: 'layout_changed', excerpt: 'no result count found in the search response' };

  const rows = [];
  const rowRe = /<td>([^<]*)<\/td>\s*<td>\s*(\d{11})\s*<\/td>\s*<td>([^<]*)<\/td>\s*<td>[\s\S]*?SeleccionarProveedor\('(\d+),/g;
  let m;
  while ((m = rowRe.exec(text))) {
    rows.push({ name: decode(m[1]), cuit: m[2], type: decode(m[3]), supplier_id: m[4] });
  }
  return { total, rows };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const kw = String(keyword || '').trim().replace(/\s+/g, ' ');
  try {
    if (!kw) return fail('other', SEARCH_URL, 'empty company name');

    // 1. Session: the search page redirects to the front page without a session cookie.
    const jar = new Map();
    const home = await fetch(DEFAULT_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    takeCookies(home, jar);
    if (home.status === 403 || home.status === 429) return fail('blocked', DEFAULT_URL, `HTTP ${home.status}`);
    if (!home.ok) return fail('http_error', DEFAULT_URL, `HTTP ${home.status}`);
    await home.text();

    // 2. The advanced-search page: gives the __VIEWSTATE needed for the postback.
    const page = await fetch(SEARCH_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Cookie': cookieHeader(jar), 'Referer': DEFAULT_URL },
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    takeCookies(page, jar);
    if (page.status >= 300 && page.status < 400) {
      return fail('blocked', SEARCH_URL, `HTTP ${page.status} to ${page.headers.get('location') || '?'}: search needs a session`);
    }
    if (page.status === 403 || page.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${page.status}`);
    if (!page.ok) return fail('http_error', SEARCH_URL, `HTTP ${page.status}`);
    const html = await page.text();
    if (/captcha/i.test(html)) return fail('blocked', SEARCH_URL, 'captcha on the search page');
    const vs = html.match(/id="__VIEWSTATE" value="([^"]*)"/);
    const vsg = html.match(/id="__VIEWSTATEGENERATOR" value="([^"]*)"/);
    if (!vs || !vsg || !html.includes(NAME_FIELD) || !html.includes(BTN)) {
      return fail('layout_changed', SEARCH_URL, 'the search page does not have the supplier search popup');
    }
    const cookie = cookieHeader(jar);

    // 3. Search: the typed name first, then the name without its legal form if nothing matched.
    const terms = [kw];
    const core = coreText(kw);
    if (core && core !== kw) terms.push(core);

    const seen = new Map();
    const truncated = [];
    let hit = null;
    for (let i = 0; i < terms.length; i++) {
      if (i > 0 && Date.now() - t0 > 30000) return fail('timeout', SEARCH_URL, 'the site was too slow for the second search');
      const term = terms[i];
      const body = new URLSearchParams({
        'ctl00$ScriptManager1': `${PANEL}|${BTN}`,
        '__EVENTTARGET': BTN,
        '__EVENTARGUMENT': '',
        '__ASYNCPOST': 'true',
        '__VIEWSTATE': vs[1],
        '__VIEWSTATEGENERATOR': vsg[1],
        [NAME_FIELD]: term,
        [CUIT_FIELD]: '',
      });
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'X-MicrosoftAjax': 'Delta=true',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': BASE,
          'Referer': SEARCH_URL,
          'Cookie': cookie,
        },
        body: body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', SEARCH_URL, `HTTP ${res.status} on search "${term}"`);
      if (!res.ok) return fail('http_error', SEARCH_URL, `HTTP ${res.status} on search "${term}"`);
      const text = await res.text();

      let parsed;
      try {
        parsed = parseResults(text);
      } catch (e) {
        return fail(e.reason || 'other', SEARCH_URL, e.excerpt || 'unreadable search response');
      }
      for (const r of parsed.rows) seen.set(r.supplier_id, r);
      if (parsed.total > parsed.rows.length) truncated.push(`"${term}": ${parsed.total} results, first page shows ${parsed.rows.length}`);

      hit = [...seen.values()].filter((r) => isSameName(r.name, kw));
      if (hit.length) break;
    }

    if (hit.length) {
      // Prefer entries whose full name, legal form included, matches; fall back to the legal-form-free match.
      const exact = hit.filter((r) => fullKey(r.name) === fullKey(kw));
      if (exact.length) hit = exact;
      return {
        status: 'found',
        reason: '',
        records: hit,
        source_url: SEARCH_URL,
        excerpt: `Buscar Constructor: ${hit.map((r) => `${r.name} | CUIT ${r.cuit} | ${r.type}`).join(' ; ')}`.slice(0, 300),
      };
    }
    if (truncated.length) {
      return fail('other', SEARCH_URL, `no exact name match on the first page; ${truncated.join('; ')}`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SEARCH_URL,
      excerpt: `Buscar Constructor: no supplier named "${kw}" (searched: ${terms.map((t) => `"${t}"`).join(', ')})`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SEARCH_URL, String(err && err.message ? err.message : err));
  }
}
