export const meta = {
  task: 'AR-enacom.gob.ar',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'code', 'service'],
  canary: { found: 'ABACOON S.R.L.', not_found: 'Empresa Inexistente Zqxw S.A.' },
};

// ENACOM "Información de prestadores" (value-added / internet / satellite providers).
// The page POSTs campo=<text>&tipo=<codes> to /licenciatariosareaslocales/busqueda/<page>. The site matches the
// text as a plain substring of the stored name, so punctuation and legal-form spelling must match what the site
// stores: the handler searches the name without its legal form, then compares the full names itself.
const PAGE_URL = 'https://www.enacom.gob.ar/informacion-de-prestadores_p1346';
const SEARCH_URL = 'https://www.enacom.gob.ar/licenciatariosareaslocales/busqueda/';
const TIPO = 'SVA,VA-INT,SAT,SARF';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['SRL', 'SA', 'SAS', 'SAU', 'SACI', 'SACIF', 'SACIFI', 'SACIFIA', 'SCA', 'SCS', 'SC', 'SH', 'LTDA', 'LIMITADA']);
const MAX_PAGES = 20;
const DEADLINE_MS = 30000;

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Split "ABACOON S.R.L." into { core: "ABACOON", key: "ABACOON", form: "SRL" }. Key = letters/digits only. */
function parseName(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  let form = '';
  while (parts.length > 1) {
    const tok = fold(parts[parts.length - 1]).replace(/\./g, '');
    if (!LEGAL.has(tok)) break;
    if (!form) form = tok;
    parts.pop();
  }
  const core = parts.join(' ');
  return { core, key: fold(core).replace(/[^A-Z0-9]/g, ''), form };
}

async function readHtml(res) {
  const buf = await res.arrayBuffer();
  const m = (res.headers.get('content-type') || '').match(/charset=([^;\s]+)/i);
  try {
    return new TextDecoder(m ? m[1].trim() : 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function parseRows(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    if (/colspan|trpaginado/i.test(tr)) continue; // paginator and "no results" rows
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
    if (cells.length >= 2 && cells[0]) rows.push({ name: cells[0], code: cells[1] || '', service: cells[2] || '' });
  }
  return rows;
}

function maxPageOf(html) {
  const nums = [...html.matchAll(/BuscarLicenciatariosAreasLocales\((\d+)\)/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 1;
}

async function postPage(term, page) {
  return fetch(SEARCH_URL + page, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PAGE_URL,
    },
    body: `campo=${encodeURIComponent(term)}&tipo=${encodeURIComponent(TIPO)}`,
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 500) });
  try {
    const want = parseName(keyword);
    if (!want.key) return fail('other', 'empty company name');

    // The site only matches accents when the query is plain ASCII ("PENA" finds "PEÑA", "PEÑA" finds nothing),
    // so the search term is the accent-free core; the exact comparison below still uses the full name.
    const term = fold(want.core).replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
    const matches = [];
    let seenRows = 0;
    let page = 1;
    let lastPage = 1;
    let complete = true;

    do {
      if (Date.now() - started > DEADLINE_MS) {
        if (matches.length) break;
        return fail('timeout', `search "${term}" still running after 30 s (page ${page})`);
      }
      if (page > MAX_PAGES) { complete = false; break; }

      const res = await postPage(term, page);
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

      const html = await readHtml(res);
      const hasRows = /<tr[\s>]/i.test(html);
      const noResults = /sinresultados|Sin resultados encontrados/i.test(html);
      if (!hasRows && !noResults) {
        if (/captcha|recaptcha|cf-chl|incapsula|access denied/i.test(html)) return fail('blocked', cleanText(html).slice(0, 300));
        return fail('layout_changed', cleanText(html).slice(0, 300));
      }

      if (page === 1) lastPage = maxPageOf(html);

      const rows = noResults && !hasRows ? [] : parseRows(html);
      if (hasRows && !noResults && rows.length === 0) return fail('layout_changed', cleanText(html).slice(0, 300));
      seenRows += rows.length;

      for (const r of rows) {
        const rn = parseName(r.name);
        if (rn.key === want.key && (!want.form || rn.form === want.form)) {
          matches.push({ name: r.name, code: r.code, service: r.service });
        }
      }
      page += 1;
    } while (page <= lastPage);

    if (lastPage > MAX_PAGES) complete = false;

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: PAGE_URL,
        excerpt: `ENACOM "Información de prestadores": ${matches.length} matching entr${matches.length === 1 ? 'y' : 'ies'} for "${keyword}" (site search "${term}", types ${TIPO}).`,
      };
    }
    if (!complete) return fail('other', `search "${term}" spans ${lastPage} pages; only ${MAX_PAGES} were read, no match yet`);

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: seenRows === 0
        ? `Sin resultados encontrados for "${term}" (types ${TIPO})`
        : `${seenRows} entries for "${term}", none matching "${keyword}" (types ${TIPO})`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, String(err && err.message ? err.message : err));
  }
}
