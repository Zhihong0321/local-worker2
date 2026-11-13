export const meta = { task: 'ES-cnmv.es', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'nif', 'lei', 'short_name', 'sector', 'capital'],
  canary: { found: 'BANCO SANTANDER, S.A.', not_found: 'Sociedad Inexistente Zyxwqv, S.L.' } };

// CNMV "Búsqueda por entidades" (ASP.NET WebForms): GET the form for its hidden tokens, POST the search words.
// The result is either "0 results", a list (select box) that is then selected with a second POST, or,
// when one entity matches, the entity page itself. The general-data page (ee/datosgenerales.aspx?nif=) gives NIF/LEI.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.cnmv.es/portal/Consultas/';
const SEARCH = BASE + 'BusquedaPorEntidad';
const LEGAL = new Set(['SA', 'SAU', 'SL', 'SLU', 'SLL', 'SRL', 'SCOOP', 'SAS', 'SICAV', 'SE', 'LTD', 'S', 'A', 'L', 'U',
  'SOCIEDAD', 'ANONIMA', 'LIMITADA', 'UNIPERSONAL']);
const DEADLINE_MS = 45000;

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function text(html) {
  return decode(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

function words(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

// Normalised name without a trailing legal form (S.A., S.L.U., ...): case, accents and punctuation ignored.
function core(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

function sameName(a, b) {
  const x = core(a);
  return x !== '' && x === core(b);
}

// The words sent to the site: the name as typed, minus a trailing legal form.
function searchTerm(name) {
  const t = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (t.length > 1 && LEGAL.has(words(t[t.length - 1]).join(''))) t.pop();
  return t.join(' ');
}

function hidden(html, id) {
  const m = String(html).match(new RegExp('id="' + id + '" value="([^"]*)"'));
  return m ? m[1] : '';
}

function formBody(html, extra) {
  const b = new URLSearchParams({
    __EVENTTARGET: '', __EVENTARGUMENT: '',
    __VIEWSTATE: hidden(html, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hidden(html, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: hidden(html, '__EVENTVALIDATION'),
  });
  for (const [k, v] of Object.entries(extra)) b.set(k, v);
  return b.toString();
}

function remember(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0].trim();
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i), kv);
  }
}

async function call(url, init, jar) {
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9', ...(init.headers || {}) };
  if (jar.size) headers.Cookie = [...jar.values()].join('; ');
  const res = await fetch(url, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  remember(res, jar);
  return res;
}

function looksBlocked(html) {
  return !/Teclee cualquier|Para esta entidad|Información de la Entidad|Han sido encontrados|No se han encontrado resultados|Datos generales/.test(html)
    && /captcha|access denied|forbidden|request unsuccessful|incapsula|unusual traffic/i.test(html);
}

const fail = (reason, excerpt, source_url = SEARCH) =>
  ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) });

const found = (records, source_url) => ({ status: 'found', reason: '', records, source_url,
  excerpt: records.map((r) => `${r.name} | NIF ${r.nif} | LEI ${r.lei}`).join(' ; ').slice(0, 300) });

// The entity's name is the heading just before "Para esta entidad" (the breadcrumb also says "Información de la Entidad").
function entityName(html) {
  const t = text(html);
  const end = t.indexOf('Para esta entidad');
  if (end < 0) return '';
  const before = t.slice(0, end);
  const label = 'Información de la Entidad';
  const k = before.lastIndexOf(label);
  return k < 0 ? '' : before.slice(k + label.length).trim();
}

function gridFields(html) {
  const out = {};
  for (const m of String(html).matchAll(/<td[^>]*data-th="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi)) {
    const label = decode(m[1]).toLowerCase();
    const value = text(m[2]);
    if (label === 'nif') out.nif = value;
    else if (label === 'lei') out.lei = value;
    else if (label.startsWith('denominaci')) out.short_name = value;
    else if (label === 'sector') out.sector = value;
    else if (label.startsWith('capital')) out.capital = value;
  }
  return out;
}

// Reads one entity page (its name, and NIF from the address) and then its general-data page for the rest.
async function detail(url, html, jar, deadline) {
  const rec = { name: entityName(html), nif: '', lei: '', short_name: '', sector: '', capital: '' };
  const nifM = url.match(/[?&]nif=([^&#]+)/i);
  if (nifM) rec.nif = decodeURIComponent(nifM[1]);
  if (rec.nif && Date.now() < deadline) {
    try {
      const g = await call(BASE + 'ee/datosgenerales.aspx?nif=' + encodeURIComponent(rec.nif), { method: 'GET' }, jar);
      if (g.ok) Object.assign(rec, gridFields(await g.text()));
    } catch (e) {
      // the extra fields are optional; the entity itself is already known
    }
  }
  return rec;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + DEADLINE_MS;
  const jar = new Map();
  const name = String(keyword || '').trim();
  try {
    if (!name) return fail('other', 'empty company name');
    const term = searchTerm(name);

    const g = await call(SEARCH, { method: 'GET' }, jar);
    const gHtml = await g.text();
    if (g.status === 403 || g.status === 429 || looksBlocked(gHtml)) return fail('blocked', 'HTTP ' + g.status + ' on the search form');
    if (!g.ok) return fail('http_error', 'HTTP ' + g.status + ' on the search form');
    if (!hidden(gHtml, '__VIEWSTATE') || !gHtml.includes('ctl00$ContentPrincipal$txtBusqueda')) return fail('layout_changed', text(gHtml));

    const p = await call(SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': SEARCH },
      body: formBody(gHtml, { 'ctl00$ContentPrincipal$txtBusqueda': term, 'ctl00$ContentPrincipal$btnBuscar': 'Buscar' }),
    }, jar);
    const pHtml = await p.text();
    if (p.status === 403 || p.status === 429 || looksBlocked(pHtml)) return fail('blocked', 'HTTP ' + p.status + ' on the search');
    if (!p.ok) return fail('http_error', 'HTTP ' + p.status + ' on the search');

    const pt = text(pHtml);
    if (/No se han encontrado resultados/i.test(pt)) {
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH, excerpt: `No se han encontrado resultados para "${term}"` };
    }

    // One match: the site opened the entity page directly.
    if (/Información de la Entidad/.test(pt) && /Para esta entidad/.test(pt)) {
      const rec = await detail(p.url, pHtml, jar, deadline);
      if (sameName(rec.name, name) || sameName(rec.short_name, name)) return found([rec], p.url);
      return { status: 'not_found', reason: '', records: [], source_url: p.url,
        excerpt: `The search for "${term}" opened only ${rec.name} (NIF ${rec.nif}), not "${name}"`.slice(0, 300) };
    }

    // Several matches: a list in the select box.
    const sel = (pHtml.match(/<select[^>]*lstSeleccion[^>]*>([\s\S]*?)<\/select>/i) || [])[1];
    if (!sel || !/Han sido encontrados/.test(pt)) return fail('layout_changed', pt);
    const opts = [...sel.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
      .map((m) => ({ value: m[1], text: decode(m[2]) }));
    if (!opts.length) return fail('layout_changed', pt);

    const hits = opts.filter((o) => sameName(o.text, name));
    if (!hits.length) {
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH,
        excerpt: `${opts.length} entities match "${term}" but none has the legal name "${name}" (compared without legal form). First: ${opts.slice(0, 5).map((o) => o.text).join(' | ')}`.slice(0, 300) };
    }

    // Open each exact match (at most 3) with the site's own "Seleccionar" button.
    const records = [];
    let sourceUrl = SEARCH;
    for (const hit of hits.slice(0, 3)) {
      if (Date.now() > deadline && records.length === 0) return fail('timeout', 'the site was too slow; stopped after 45 s');
      if (Date.now() > deadline) break;
      const r = await call(SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': SEARCH },
        body: formBody(pHtml, { 'ctl00$ContentPrincipal$wuc_Entidades$lstSeleccion': hit.value, 'ctl00$ContentPrincipal$wuc_Entidades$btnSeleccionar': 'Seleccionar' }),
      }, jar);
      const rHtml = await r.text();
      if (!r.ok) return fail('http_error', 'HTTP ' + r.status + ' when opening ' + hit.text);
      if (!/Información de la Entidad/.test(text(rHtml)) || !/Para esta entidad/.test(text(rHtml))) return fail('layout_changed', text(rHtml));
      records.push(await detail(r.url, rHtml, jar, deadline));
      sourceUrl = r.url;
    }
    return found(records, sourceUrl);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', String((err && err.message) || err));
  }
}
