export const meta = {
  task: 'ES-aemps.gob.es',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'section', 'registration_number', 'mia_number', 'labofar_id', 'cif', 'razon_social', 'direccion', 'localidad', 'provincia', 'codigo_postal', 'fecha_ultima_modificacion'],
  canary: { found: 'ADAMED FARMACEUTICA S.L.U.', not_found: 'Laboratorios Inexistentes Ficticios S.L.' },
};

// AEMPS register of pharmaceutical laboratories (LABOFAR). The public search is a form POST:
// section "mia" = manufacturers/importers, section "wda" = marketing-authorisation holders with storage.
const PAGE = 'https://labofar.aemps.es/labofar/registro/farmaceutico/consulta.do';
const BASE = 'https://labofar.aemps.es/labofar/registro/farmaceutico';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SECTIONS = {
  mia: { label: 'Fabricantes/importadores (MIA)', detailPath: 'fabricantes-importadores/consulta.do', table: 'laboratorioMIA' },
  wda: { label: 'Titulares de autorización de comercialización (WDA)', detailPath: 'titulares/consulta.do', table: 'laboratorioWDA' },
};
// Stop starting new requests after 30 s so the whole call stays under 60 s.
const LATE_AFTER_MS = 30000;

const LEGAL_TAIL = /[\s,.]*\b(s\.?\s?l\.?\s?u\.?|s\.?\s?a\.?\s?u\.?|s\.?\s?l\.?\s?l\.?|s\.?\s?coop\.?|s\.?\s?l\.?|s\.?\s?a\.?|slu|sau|sl|sa)\s*$/i;
const LEGAL_SEQS = [['S', 'L', 'U'], ['S', 'A', 'U'], ['S', 'L', 'L'], ['S', 'COOP'], ['S', 'L'], ['S', 'A'], ['SLU'], ['SAU'], ['SLL'], ['SL'], ['SA']];

/** Legal-form-free core of a name, keeping the user's spelling, to send to the site's "contains" search. */
function coreName(name) {
  const original = String(name || '').trim();
  let s = original;
  for (let i = 0; i < 3; i++) {
    const t = s.replace(LEGAL_TAIL, '').trim();
    if (!t || t === s) break;
    s = t;
  }
  return s || original;
}

/** Normalised name for comparison: no accents, case or punctuation, and no trailing legal form. */
function norm(name) {
  let t = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const seq of LEGAL_SEQS) {
      const n = seq.length;
      if (t.length > n && seq.every((x, i) => t[t.length - n + i] === x)) {
        t = t.slice(0, -n);
        changed = true;
      }
    }
  }
  return t.join(' ');
}

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#039;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Form body in ISO-8859-1, the charset the LABOFAR server reads (UTF-8 bytes make accented names miss). */
function formBody(fields) {
  const enc = (s) => [...String(s)].map((ch) => {
    const c = ch.codePointAt(0);
    if (c < 128 && /[A-Za-z0-9._~-]/.test(ch)) return ch;
    if (c === 32) return '+';
    if (c < 256) return '%' + c.toString(16).toUpperCase().padStart(2, '0');
    return encodeURIComponent(ch);
  }).join('');
  return Object.entries(fields).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

/** One HTTP call with the 25 s timeout and browser-like headers. Never throws. */
async function request(url, { method = 'GET', body = null, cookie = '' } = {}) {
  try {
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' };
    if (cookie) headers.Cookie = cookie;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Referer = PAGE;
    }
    const res = await fetch(url, { method, headers, body: body ? formBody(body) : undefined, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status} from ${url}` };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status} from ${url}` };
    const html = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
    if (/recaptcha|captcha|j_security_check|name="j_password"/i.test(html)) {
      return { ok: false, reason: 'blocked', excerpt: `captcha or login page from ${url}` };
    }
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { ok: true, html, cookie: cookies.map((c) => c.split(';')[0]).join('; ') };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
  }
}

/** Search one section by name. Returns the rows on the first page and how many rows the site reports. */
async function search(section, term, cookie) {
  const got = await request(`${PAGE}?metodo=detalleBusqueda`, {
    method: 'POST', cookie,
    body: { 'laboratorioBusqueda.nombre': term, nombreBusqueda: term, ambito: section, metodo: 'detalleBusqueda' },
  });
  if (!got.ok) return got;
  const html = got.html;
  if (/No se ha encontrado ning[uú]n laboratorio/i.test(html)) return { ok: true, total: 0, rows: [], truncated: false };

  const table = html.match(new RegExp(`<table[^>]*id="${SECTIONS[section].table}"[\\s\\S]*?<\\/table>`, 'i'));
  if (!table) return { ok: false, reason: 'layout_changed', excerpt: `no result table or "no results" text in the ${section} search` };

  const rows = [];
  for (const tr of table[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const link = tr.match(/detalle\('(\d+)'[^)]*\)[\s\S]*?>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const values = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => clean(c[1])).slice(1);
    rows.push({ id: link[1], name: clean(link[2]), values });
  }
  const bank = html.match(/pagebanner">\s*(Una fila|(\d+) filas)/i);
  const total = bank ? (bank[2] ? Number(bank[2]) : 1) : rows.length;
  return { ok: true, total, rows, truncated: total > rows.length };
}

/** Detail page of one matched company: CIF, business name, address and last change. */
async function detail(section, id, cookie) {
  const got = await request(`${BASE}/${SECTIONS[section].detailPath}?metodo=detalleGeneral`, {
    method: 'POST', cookie,
    body: { ambito: section, idEmpresa: id, metodo: 'detalleGeneral' },
  });
  if (!got.ok) return got;
  const field = (label) => {
    const m = got.html.match(new RegExp(`>\\s*${escapeRe(label)}\\s*<\\/td>\\s*<td[^>]*>\\s*<input[^>]*value="([^"]*)"`, 'i'));
    return m ? clean(m[1]) : '';
  };
  return {
    ok: true,
    fields: {
      cif: field('CIF'),
      razon_social: field('Razón social'),
      direccion: field('Dirección'),
      localidad: field('Localidad'),
      provincia: field('Provincia'),
      codigo_postal: field('Código postal'),
      fecha_ultima_modificacion: field('Fecha última modificación'),
    },
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const late = () => Date.now() - started > LATE_AFTER_MS;
  const sourceUrl = PAGE;
  try {
    const wanted = norm(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'empty company name' };
    }

    // 1. Open the search page: the session cookie is needed for the detail pages.
    const page = await request(PAGE);
    if (!page.ok) return { status: 'couldnt_check', reason: page.reason, records: [], source_url: sourceUrl, excerpt: page.excerpt };
    const cookie = page.cookie;

    // 2. Search both sections (one after the other, in the same session).
    const term = coreName(keyword);
    const searches = {};
    for (const section of ['mia', 'wda']) {
      searches[section] = late()
        ? { ok: false, reason: 'timeout', excerpt: `skipped the ${section} search: 30 s already used` }
        : await search(section, term, cookie);
    }

    // 3. Keep the rows whose normalised name is the same company.
    const matches = [];
    for (const section of ['mia', 'wda']) {
      const s = searches[section];
      if (s.ok) for (const row of s.rows) if (norm(row.name) === wanted) matches.push({ section, row });
    }

    if (matches.length) {
      const records = [];
      for (const { section, row } of matches) {
        const rec = { name: row.name, section: SECTIONS[section].label, labofar_id: row.id };
        if (section === 'mia') {
          rec.mia_number = row.values[0] || '';
          rec.registration_number = row.values[1] || '';
        } else {
          rec.registration_number = row.values[0] || '';
        }
        if (!late()) {
          const d = await detail(section, row.id, cookie);
          if (d.ok) Object.assign(rec, d.fields);
          else rec.detail_note = `detail page not read: ${d.reason}`;
        } else {
          rec.detail_note = 'detail page not read: 30 s already used';
        }
        records.push(rec);
      }
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: `${records.length} match(es) for "${keyword}" in the AEMPS laboratories register: ${records.map((r) => r.name).join('; ')}`,
      };
    }

    // 4. No match: only "not_found" when both sections answered completely.
    const unsure = ['mia', 'wda'].filter((s) => !searches[s].ok || searches[s].truncated);
    if (unsure.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `No laboratory named "${keyword}" in either section (fabricantes/importadores and titulares); search term "${term}"`,
      };
    }
    const bad = searches[unsure[0]];
    const excerpt = bad.truncated
      ? `${bad.total} rows for "${term}" in the ${unsure[0]} section; only the first page was read, so the match could not be checked`
      : bad.excerpt;
    return { status: 'couldnt_check', reason: bad.truncated ? 'other' : bad.reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
