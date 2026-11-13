export const meta = {
  task: 'AR-cnrt.gob.ar',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'empresa_nro', 'doc_type', 'doc_number', 'paut'],
  canary: { found: 'ZENIT TRANSPORTE S.R.L.', not_found: 'EMPRESA INEXISTENTE ZZQX S.R.L.' },
};

const SITE = 'https://consultapme.cnrt.gob.ar';
const PAGE = SITE + '/empresas_habilitadas';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words at the end of a company name (checked after dots are removed; case-insensitive).
const LEGAL_TAIL = /\s+(?:S A S|S C A|S C S|S A|S R L|SAS|SCA|SCS|SRL|SA|SL|LTDA|CISA|C I S A|C I|CIA|SOCIEDAD ANONIMA|SOCIEDAD DE RESPONSABILIDAD LIMITADA|EN RECONOCIMIENTO|EN RECONOC|RECONOCIMIENTO)$/i;

function searchTerm(keyword) {
  let t = String(keyword || '').replace(/\([^)]*\)?/g, ' ').replace(/\./g, '').replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = t; t = t.replace(LEGAL_TAIL, '').trim(); } while (t !== prev);
  return t;
}

/** Upper-case, accents removed, punctuation removed, legal form removed: used to compare names. */
function core(s) {
  let c = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/\./g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let prev;
  do { prev = c; c = c.replace(LEGAL_TAIL, '').trim(); } while (c !== prev);
  return c;
}

function cleanText(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'").replace(/\s+/g, ' ').trim();
}

async function readText(res) {
  const buf = await res.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

function cookiesFrom(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return raw.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function tokenFrom(html) {
  const tags = html.match(/<input[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/name="empresas_habilitadas\[_token\]"/i.test(tag)) {
      const v = tag.match(/value="([^"]*)"/i);
      if (v) return v[1];
    }
  }
  return '';
}

/** Returns the result rows of the results table, or null when no such table is on the page. */
function parseRows(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const table = tables.find((t) => /Raz[oó]n\s+Social/i.test(t));
  if (!table) return null;
  const rows = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
    if (cells.length >= 4) {
      rows.push({ empresa_nro: cells[0], name: cells[1], doc_type: cells[2], doc_number: cells[3], paut: cells[4] || '' });
    }
  }
  return rows;
}

const fail = (status, reason, source_url, excerpt) => ({ status, reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const term = searchTerm(keyword);
  const key = core(keyword);
  if (!term || !key) return fail('couldnt_check', 'other', PAGE, 'empty company name');
  try {
    // Step 1: the form page gives a session cookie and a form token.
    const getRes = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (getRes.status === 403 || getRes.status === 429) return fail('couldnt_check', 'blocked', PAGE, `HTTP ${getRes.status}`);
    if (!getRes.ok) return fail('couldnt_check', 'http_error', PAGE, `HTTP ${getRes.status}`);
    const getHtml = await readText(getRes);
    if (/captcha/i.test(getHtml)) return fail('couldnt_check', 'blocked', PAGE, 'captcha on the form page');
    const token = tokenFrom(getHtml);
    if (!token) return fail('couldnt_check', 'layout_changed', PAGE, getHtml.slice(0, 300));
    const cookie = cookiesFrom(getRes);

    // Step 2: post the search, the same way the form does.
    const body = new URLSearchParams({
      'empresas_habilitadas[razonSocial]': term,
      'empresas_habilitadas[empresaNro]': '',
      'empresas_habilitadas[nroDocumento]': '',
      'empresas_habilitadas[paut]': '',
      'empresas_habilitadas[_token]': token,
      'empresas_habilitadas[Enviar consulta]': '',
    });
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': PAGE,
    };
    if (cookie) headers['Cookie'] = cookie;
    const postRes = await fetch(PAGE, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) return fail('couldnt_check', 'blocked', PAGE, `HTTP ${postRes.status}`);
    if (!postRes.ok) return fail('couldnt_check', 'http_error', PAGE, `HTTP ${postRes.status}`);
    if (/\/login/i.test(postRes.url)) return fail('couldnt_check', 'blocked', PAGE, 'redirected to a login page');

    const html = await readText(postRes);
    if (/captcha/i.test(html)) return fail('couldnt_check', 'blocked', PAGE, 'captcha on the results page');

    let rows = parseRows(html);
    if (rows === null) {
      if (/No se encontr[oó] ning[uú]n registro/i.test(html)) rows = [];
      else return fail('couldnt_check', 'layout_changed', PAGE, cleanText(html).slice(0, 300));
    }

    // Match the company itself: same name once case, accents, punctuation and legal form are removed.
    const matches = rows.filter((r) => core(r.name) === key);
    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: PAGE,
        excerpt: matches.map((r) => `${r.name} | ${r.doc_type} ${r.doc_number} | N° Emp ${r.empresa_nro}`).join(' ;; ').slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: rows.length === 0
        ? `No se encontró ningún registro para la búsqueda "${term}"`
        : `${rows.length} similar entries for "${term}", none with the same normalised name: ` + rows.slice(0, 5).map((r) => r.name).join(' ; ').slice(0, 400),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', PAGE, String(err?.message || err).slice(0, 300));
  }
}
