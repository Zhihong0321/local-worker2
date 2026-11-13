export const meta = {
  task: 'ES-expansion.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'codigo', 'provincia', 'sector', 'legal_form'],
  canary: { found: 'INDITEX SA', not_found: 'Zyxwvq Tdfgh SL' },
};

// Expansion's company directory (Axesor data). The public page /empresas-de/buscadorEmpresas.html loads its
// results from this JSON endpoint; the handler calls the same endpoint directly.
const API = 'https://www.expansion.com/app/fichasAxesor/buscadorEmpresa.html';
const PAGE = 'https://www.expansion.com/empresas-de/buscadorEmpresas.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROW_CAP = 1000; // the endpoint returns at most 1000 rows per search

// Legal forms: long phrases first, then the short codes. The comparison uses the canonical code.
const LEGAL_PHRASES = [
  ['SOCIEDAD ANONIMA LABORAL', 'SAL'],
  ['SOCIEDAD LIMITADA LABORAL', 'SLL'],
  ['SOCIEDAD ANONIMA UNIPERSONAL', 'SAU'],
  ['SOCIEDAD LIMITADA UNIPERSONAL', 'SLU'],
  ['SOCIEDAD ANONIMA', 'SA'],
  ['SOCIEDAD LIMITADA', 'SL'],
  ['SOCIEDAD COOPERATIVA', 'SCOOP'],
];
const LEGAL_CODES = new Set(['SA', 'SL', 'SLL', 'SAL', 'SLU', 'SAU', 'SCOOP', 'AIE', 'SCP']);
const LEGAL_WORDS = new Set(['SOCIEDAD', 'ANONIMA', 'LIMITADA', 'LABORAL', 'UNIPERSONAL', 'COOPERATIVA']);
const TRAILING_SPACED = [['S A U', 'SAU'], ['S L U', 'SLU'], ['S L L', 'SLL'], ['S A L', 'SAL'], ['S A', 'SA'], ['S L', 'SL']];

/** Upper case, no accents, no punctuation, single spaces. */
function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[.,;:'"`()\/\-_&]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Split a company name into its base words and its canonical legal-form code ('' when none). */
function split(name) {
  let s = ' ' + fold(name) + ' ';
  let form = '';
  for (const [phrase, code] of LEGAL_PHRASES) {
    if (s.includes(' ' + phrase + ' ')) { form = code; s = s.replace(' ' + phrase + ' ', ' '); }
  }
  for (const [spaced, code] of TRAILING_SPACED) {
    if (s.endsWith(' ' + spaced + ' ')) { form = code; s = s.slice(0, -(spaced.length + 1)) + ' '; }
  }
  const base = [];
  for (const w of s.trim().split(' ').filter(Boolean)) {
    if (LEGAL_CODES.has(w)) { form = form || w; continue; }
    if (LEGAL_WORDS.has(w)) continue;
    base.push(w);
  }
  return { base: base.join(' '), form };
}

/** The text sent to the search: the name as typed, without the legal form. */
function searchText(name) {
  return (name || '').replace(/\./g, ' ').split(/\s+/)
    .filter((w) => w && !LEGAL_CODES.has(fold(w)) && !LEGAL_WORDS.has(fold(w)))
    .join(' ').trim();
}

async function run(keyword) {
  const query = searchText(keyword);
  const sourceUrl = `${PAGE}?qe=${encodeURIComponent(query)}`;
  try {
    const want = split(keyword);
    if (!want.base) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'no company name in the input' };
    }

    const res = await fetch(`${API}?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE,
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }

    const buf = await res.arrayBuffer();
    let text;
    try { text = new TextDecoder('iso-8859-15').decode(buf); } catch { text = new TextDecoder().decode(buf); }

    if (text.trim() === 'Acceso no autorizado') {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: 'Acceso no autorizado' };
    }

    let rows;
    try { rows = JSON.parse(text); } catch { rows = null; }
    if (!Array.isArray(rows)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: text.slice(0, 300) };
    }

    const matches = rows.filter((r) => {
      const got = split(r?.nombre || '');
      return got.base === want.base && (!want.form || got.form === want.form);
    });

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.nombre || '',
          codigo: String(r.codigo ?? ''),
          provincia: r.provincia?.descripcion || '',
          sector: r.seccion?.descripcion || '',
          legal_form: split(r.nombre).form,
        })),
        source_url: sourceUrl,
        excerpt: matches.map((r) => `${r.nombre} | codigo ${r.codigo} | ${r.provincia?.descripcion || ''} | ${r.seccion?.descripcion || ''}`).join(' ; ').slice(0, 500),
      };
    }

    // The list is capped: without the whole list an absent name cannot be told apart from a cut-off one.
    if (rows.length >= ROW_CAP) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: `list capped at ${ROW_CAP} rows; exact name not seen` };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `${rows.length} rows for "${query}", none named "${keyword}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Node on Windows aborts ("UV_HANDLE_CLOSING") when the process exits in the same tick as a finished fetch whose
  // timeout signal is still live. A short pause lets the socket settle before the caller exits.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return answer;
}
