export const meta = {
  task: 'AR-enargas.gob.ar',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'cuit', 'address', 'location', 'phone', 'website', 'email', 'certificate', 'expiry'],
  canary: { found: 'MetroGAS S.A.', not_found: 'Distribuidora Gas Inexistente S.A.' },
};

const BASE = 'https://www.enargas.gob.ar';
const DIR_PAGE = `${BASE}/secciones/directorio-industria/directorio-industria.php`;
const DIR_URL = `${BASE}/secciones/directorio-industria/listado-entidades.php`;
const GNC_PAGE = `${BASE}/secciones/gas-natural-comprimido/sujetos-gnc-habilitados.php`;
const GNC_BASE = `${BASE}/secciones/gas-natural-comprimido/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Gas industry directory: one POST per entity type (type 6 is the GNC list, below).
const DIR_TYPES = [
  [1, 'Licenciatarias de Distribución'],
  [2, 'Licenciatarias de Transporte'],
  [3, 'Subdistribuidoras'],
  [10, 'Prestadores de servicio (en trámite)'],
  [4, 'Comercializadores'],
  [5, 'Organismos de Certificación'],
  [7, 'Asociaciones de consumidor'],
  [8, 'Organismos y Empresas del Estado'],
  [11, 'Gasistas Matriculados por Distribuidora'],
  [12, 'Almacenadores'],
  [9, 'Otras Instituciones'],
];

// GNC subjects, all provinces (999). Talleres need pecs=1 ("Todos").
const GNC_TYPES = [
  { list: 'Productores de Equipo Completo (PEC)', file: 'detalle-sujeto-pec-crpc.php', body: 'provincia=999&tipo_sujeto=1' },
  { list: 'Centros de Revisión de Cilindros (CRPC)', file: 'detalle-sujeto-pec-crpc.php', body: 'provincia=999&tipo_sujeto=2' },
  { list: 'Talleres de Montaje Certificados según NAG E 408', file: 'detalle-sujeto-tdm.php', body: 'provincia=999&tipo_sujeto=3&pecs=1' },
  { list: 'Fabricantes y/o Importadores', file: 'detalle-sujeto-fi.php', body: 'provincia=999&tipo_sujeto=4' },
  { list: 'Estaciones de Carga', file: 'detalle-sujeto-ec.php', body: 'provincia=999&tipo_sujeto=5' },
];

const ENTITIES = new Map([
  ['aacute', 'á'], ['eacute', 'é'], ['iacute', 'í'], ['oacute', 'ó'], ['uacute', 'ú'], ['ntilde', 'ñ'],
  ['Aacute', 'Á'], ['Eacute', 'É'], ['Iacute', 'Í'], ['Oacute', 'Ó'], ['Uacute', 'Ú'], ['Ntilde', 'Ñ'],
  ['uuml', 'ü'], ['Uuml', 'Ü'], ['amp', '&'], ['nbsp', ' '], ['quot', '"'], ['apos', "'"],
  ['lt', '<'], ['gt', '>'], ['ordm', 'º'], ['ordf', 'ª'], ['deg', '°'], ['lsquo', '‘'], ['rsquo', '’'],
  ['ldquo', '“'], ['rdquo', '”'], ['ndash', '–'], ['mdash', '—'],
  ['Atilde', 'Ã'], ['Acirc', 'Â'], ['permil', '‰'],
]);

// Some pages hold UTF-8 bytes that were decoded once as windows-1252 (e.g. "BÃ©CCAR" for "BÉCCAR").
const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
const CP1252_REV = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

function fixMojibake(s) {
  if (!/[ÂÃ]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x100) bytes.push(cp);
    else if (CP1252_REV.has(cp)) bytes.push(CP1252_REV.get(cp));
    else return s;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return s;
  }
}

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES.has(e) ? ENTITIES.get(e) : m;
  });
}

function cleanText(html) {
  const text = decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '));
  return fixMojibake(text).replace(/\s+/g, ' ').trim();
}

// Some pages are windows-1252, others UTF-8. Try strict UTF-8 first.
function decodeBody(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// Compare company names: upper case, no accents, no punctuation, no trailing legal form.
const LEGAL_TAIL = /\s+(SOCIEDAD ANONIMA UNIPERSONAL|SOCIEDAD ANONIMA|SOCIEDAD DE RESPONSABILIDAD LIMITADA|S A U|S A S|S R L|S A I C Y F A|S A I C Y F|S A I C|S A C I F I A|S A C I F|S A C I|S A|S C A|S L|S C|LTDA|SRL|SA|SAU|SAS|SACIFIA|SACIF|SACI|SCA)$/;
function coreName(name) {
  let s = fixMojibake(decodeEntities(name)).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  s = s.replace(/\./g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(LEGAL_TAIL, '').trim(); } while (s !== prev);
  return s;
}

function field(block, label) {
  const m = block.match(new RegExp('<strong>\\s*' + label + '\\s*:?\\s*</strong>([\\s\\S]*?)(?:</p>|<br)', 'i'));
  return m ? cleanText(m[1]) : '';
}

function parseDirectory(html, list) {
  const records = [];
  const blocks = html.split('class="well margin-0"').slice(1);
  for (const block of blocks) {
    const name = field(block, 'Raz[oó]n social');
    if (!name) continue;
    const paragraphs = block.match(/<p>[\s\S]*?<\/p>/gi) || [];
    const plain = paragraphs.find((p) => !/<strong>/i.test(p));
    records.push({
      name,
      list,
      cuit: '',
      address: field(block, 'Direcci[oó]n'),
      location: plain ? cleanText(plain) : '',
      phone: field(block, 'Tel[eé]fono'),
      website: field(block, 'Sitio web'),
      email: field(block, 'Correo electr[oó]nico'),
      certificate: '',
      expiry: '',
    });
  }
  return records;
}

function parseTable(html, list) {
  const table = (html.match(/<table[\s\S]*?<\/table>/i) || [])[0] || '';
  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cleanText(m[1]));
  const at = (re) => headers.findIndex((h) => re.test(h));
  const iName = at(/^raz/i);
  if (iName < 0) return null;
  const iCuit = at(/^cuit/i);
  const iAddr = at(/^domicilio|^direcci/i);
  const iProv = at(/^provincia/i);
  const iLoc = at(/^localidad/i);
  const iPhone = at(/^tel/i);
  const iCert = at(/certificado/i);
  const iExp = at(/^vencimiento/i);
  const records = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanText(m[1]));
    if (tds.length < headers.length) continue;
    // Some rows carry extra leading cells; the data cells are the last ones.
    const offset = tds.length - headers.length;
    const cell = (i) => (i >= 0 ? tds[offset + i] || '' : '');
    const name = cell(iName);
    if (!name) continue;
    const place = [cell(iLoc), cell(iProv)].filter(Boolean).join(', ');
    records.push({
      name,
      list,
      cuit: cell(iCuit),
      address: cell(iAddr),
      location: place,
      phone: cell(iPhone),
      website: '',
      email: '',
      certificate: cell(iCert),
      expiry: cell(iExp),
    });
  }
  return records;
}

async function fetchSource(src) {
  const base = { list: src.list, source_url: src.page, records: [] };
  try {
    const res = await fetch(src.url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': src.page,
      },
      body: src.body,
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { ...base, status: 'fail', reason: 'blocked', excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ...base, status: 'fail', reason: 'http_error', excerpt: `HTTP ${res.status}` };
    }
    const html = decodeBody(new Uint8Array(await res.arrayBuffer()));
    if (/captcha|cf-chl|access denied/i.test(html)) {
      return { ...base, status: 'fail', reason: 'blocked', excerpt: html.slice(0, 200) };
    }
    if (src.kind === 'dir') {
      if (/No se encuentran entidades/i.test(html)) return { ...base, status: 'ok', records: [] };
      if (/Raz[oó]n social/i.test(html)) return { ...base, status: 'ok', records: parseDirectory(html, src.list) };
      return { ...base, status: 'fail', reason: 'layout_changed', excerpt: cleanText(html).slice(0, 200) };
    }
    if (/No se registran|No se encuentran/i.test(html)) return { ...base, status: 'ok', records: [] };
    const records = parseTable(html, src.list);
    if (records) return { ...base, status: 'ok', records };
    return { ...base, status: 'fail', reason: 'layout_changed', excerpt: cleanText(html).slice(0, 200) };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ...base, status: 'fail', reason: timeout ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const key = coreName(kw);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIR_PAGE, excerpt: 'empty company name' };
    }

    const sources = [
      ...DIR_TYPES.map(([id, label]) => ({
        kind: 'dir', list: label, page: DIR_PAGE, url: DIR_URL, body: `tipo_entidad=${id}`,
      })),
      ...GNC_TYPES.map((t) => ({
        kind: 'gnc', list: t.list, page: GNC_PAGE, url: GNC_BASE + t.file, body: t.body,
      })),
    ];

    const results = await Promise.all(sources.map(fetchSource));

    const matches = [];
    for (const r of results) {
      for (const rec of r.records) {
        if (coreName(rec.name) === key) matches.push({ ...rec, source_url: r.source_url });
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matches[0].source_url,
        excerpt: matches.map((m) => `${m.list}: ${m.name}`).join(' | ').slice(0, 500),
      };
    }

    // A list that could not be read means we cannot say "not listed".
    const failed = results.filter((r) => r.status === 'fail');
    if (failed.length) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      failed.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason));
      const f = failed[0];
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.source_url,
        excerpt: `${failed.length} of ${results.length} lists could not be read; first: ${f.list}: ${f.excerpt}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: DIR_PAGE,
      excerpt: `Not in ${DIR_TYPES.length} directory lists or ${GNC_TYPES.length} GNC lists (all provinces)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: DIR_PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
