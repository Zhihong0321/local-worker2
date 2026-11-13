export const meta = { task: 'AR-idea.org.ar', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'category'],
  canary: { found: 'ACCENTURE S.R.L.', not_found: 'Empresa Inexistente Ficticia S.A.' } };

// IDEA publishes its member companies ("Empresas Socias") as one plain HTML list, with no paging and no search form.
const LIST_URL = 'https://www.idea.org.ar/sobre-idea/empresas-socias/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIN_ROWS = 100; // the list has about 600 companies; far fewer means the page is not the list we expect

// Legal-form words that are dropped from the end of a name before comparing (dots are removed first: "S.A." -> "sa").
const LEGAL_TAIL = new Set(['sa', 'sas', 'srl', 'sau', 'saic', 'saicf', 'sgr', 'sca', 'scs', 'sh', 'sc', 'se', 'sl',
  'ltda', 'ltd', 'inc', 'llc', 'ace', 'sociedad', 'anonima', 'responsabilidad', 'limitada', 'colectiva']);

/** Normalised comparison key: no accents, no case, no punctuation, no trailing legal form. */
function nameKey(s) {
  const t = (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[.´`'’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const words = t ? t.split(' ') : [];
  while (words.length && LEGAL_TAIL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function decodeText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#8217;|&rsquo;/gi, '’')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Every company row of the member list: { name, category }. */
function parseRows(html) {
  const rows = [];
  const re = /<li class="col-empresa-new[^"]*"[^>]*>\s*<div class="nombre">([\s\S]*?)<\/div>\s*(?:<div class="ramo">([\s\S]*?)<\/div>)?/g;
  let m;
  while ((m = re.exec(html))) {
    const name = decodeText(m[1]);
    if (name) rows.push({ name, category: decodeText(m[2] || '') });
  }
  return rows;
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = String(keyword || '').trim();
    if (!query) return fail('other', 'empty company name');

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    const rows = html.includes('empresas_socias__grid') ? parseRows(html) : [];
    if (rows.length < MIN_ROWS) {
      if (/captcha|cf-chl|challenge-platform|just a moment|access denied/i.test(html)) return fail('blocked', 'bot check page');
      return fail('layout_changed', `member list not found; ${rows.length} rows; start: ${html.slice(0, 200)}`);
    }

    const target = nameKey(query);
    if (!target) return fail('other', 'the company name has no letters or digits');

    const matches = rows.filter((r) => nameKey(r.name) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `Searched ${rows.length} member companies listed on the page; no name matches "${query}".`,
      };
    }
    return {
      status: 'found', reason: '',
      records: matches.map((r) => ({ name: r.name, category: r.category })),
      source_url: LIST_URL,
      excerpt: matches.map((r) => (r.category ? `${r.name} (${r.category})` : r.name)).join('; ').slice(0, 300),
    };
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', String(err.message || err));
    return fail('other', String((err && err.message) || err));
  }
}
