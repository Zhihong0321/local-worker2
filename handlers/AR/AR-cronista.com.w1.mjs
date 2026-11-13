export const meta = { task: 'AR-cronista.com', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['name', 'sector', 'address', 'website', 'phone', 'shareholders', 'employees', 'estimated_revenue', 'ceo', 'executives'],
  canary: { found: 'Bioceres Crop Solutions', not_found: 'Distribuidora Inexistente Zeta S.A.' } };

const SOURCE_URL = 'https://www.cronista.com/quien-es-quien/empresa/';
const MARKER = '"quien-es-quien":{"undefined":{"data":';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are only stripped from the END of a name (so "Ledesma S.A.A.I." matches "Ledesma").
const LEGAL_TOKENS = new Set(['sa', 'sas', 'srl', 'saic', 'saicf', 'saicyf', 'sacif', 'sacifya', 'saci', 'saai', 'sau',
  'sca', 'sc', 'sh', 'ltda', 'ltd', 'inc', 'llc', 'corp', 'co', 'sl', 'spa', 'gmbh', 'cia', 'compania', 'y', 'a', 'f', 'i', 'c', 'e']);

function normName(s) {
  let t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/\./g, '').replace(/[,'"()\-&/]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = t.split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// The page embeds its company list as JSON inside a script. Cut out the array with bracket matching and parse it.
function extractCompanies(html) {
  const i = html.indexOf(MARKER);
  if (i < 0) return null;
  const start = i + MARKER.length - 0;
  if (html[start] !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, j + 1));
    }
  }
  return null;
}

function toRecord(c) {
  const d = c.datos_empresa || {};
  const ceo = c.ceo && c.ceo.nombre ? `${c.ceo.nombre} ${c.ceo.apellido || ''} - ${c.ceo.cargo || ''}`.trim() : '';
  return {
    name: c.empresa || '',
    sector: [c.rubro, c.subrubro].filter(Boolean).join(' / '),
    address: c.direccion || '',
    website: c.pagina || '',
    phone: c.telefono || '',
    shareholders: c.accionistas || '',
    employees: d.cantidad_empleados || '',
    estimated_revenue: d.facturacion_estimada || '',
    ceo,
    executives: (c.personas || []).map((p) => `${p.nombre || ''} ${p.apellido || ''} - ${p.cargo || ''}`.trim()),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOURCE_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-AR,es;q=0.9' },
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    let companies = null;
    try { companies = extractCompanies(html); } catch (e) { companies = null; }
    if (!Array.isArray(companies)) {
      if (/captcha|challenge-platform|access denied/i.test(html.slice(0, 20000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SOURCE_URL, excerpt: html.slice(0, 200) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SOURCE_URL, excerpt: html.slice(0, 200) };
    }

    const wanted = normName(name);
    const matches = companies.filter((c) => c && c.mostrar !== false && normName(c.empresa) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SOURCE_URL,
        excerpt: `No match for "${name}" in the company list (${companies.length} companies)`,
      };
    }

    const records = matches.map(toRecord);
    return {
      status: 'found', reason: '', records, source_url: SOURCE_URL,
      excerpt: `Quien es quien: ${records[0].name} - ${records[0].sector}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: SOURCE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
