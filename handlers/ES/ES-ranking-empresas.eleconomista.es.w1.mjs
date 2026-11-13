export const meta = {
  task: 'ES-ranking-empresas.eleconomista.es',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_form', 'address', 'locality', 'activity', 'share_capital', 'sales', 'ranking_national', 'ranking_province', 'ranking_sector'],
  canary: { found: 'MERCADONA SA', not_found: 'ZZQWXV INEXISTENTE SOCIEDAD LIMITADA' },
};

const BASE = 'https://ranking-empresas.eleconomista.es';
const SEARCH_PATH = '/servlet/app/portal/EMP/prod/XML_AJAX_BUSQUEDA_KEY/?query=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Spanish legal forms, longest first. Matched only at the END of a name.
const LEGAL_TAILS = [
  ['SOCIEDAD', 'ANONIMA', 'UNIPERSONAL'], ['SOCIEDAD', 'LIMITADA', 'UNIPERSONAL'], ['SOCIEDAD', 'LIMITADA', 'PROFESIONAL'],
  ['SOCIEDAD', 'ANONIMA'], ['SOCIEDAD', 'LIMITADA'], ['SOCIEDAD', 'COOPERATIVA'],
  ['S', 'A', 'U'], ['S', 'L', 'U'], ['S', 'L', 'L'], ['S', 'L', 'N', 'E'], ['S', 'COOP'],
  ['SCOOP'], ['SAU'], ['SLU'], ['SLL'], ['SA'], ['SL'], ['SC'], ['SRL'], ['S', 'A'], ['S', 'L'],
];
// Connecting words the site drops or spells differently; ignored when comparing names.
const STOP = new Set(['DE', 'DEL', 'LA', 'LAS', 'EL', 'LOS', 'Y', 'E', 'EN', 'AL']);
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', middot: '·', iexcl: '¡', iquest: '¿',
  ordf: 'ª', ordm: 'º', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É',
  iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü',
  ccedil: 'ç', Ccedil: 'Ç', agrave: 'à', egrave: 'è', ograve: 'ò',
};

function codePoint(n) {
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (Object.prototype.hasOwnProperty.call(NAMED, n) ? NAMED[n] : m));
}

function stripTags(s) {
  return decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Upper-case ASCII word tokens: accents removed, punctuation split away ("S.A." -> S A).
function tokens(name) {
  return decode(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

function coreTokens(name) {
  let t = tokens(name);
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    for (const tail of LEGAL_TAILS) {
      if (t.length > tail.length && tail.every((w, i) => t[t.length - tail.length + i] === w)) {
        t = t.slice(0, t.length - tail.length);
        changed = true;
        break;
      }
    }
  }
  return t;
}

// Comparison key: legal form and connecting words removed.
function keyOf(name) {
  const core = coreTokens(name);
  const k = core.filter((w) => !STOP.has(w));
  return (k.length ? k : core).join(' ');
}

function out(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = res.status === 200 ? await res.text() : '';
  return { status: res.status, text };
}

function blockedResponse(r) {
  return r.status === 403 || r.status === 429 || (r.status === 200 && /Demasiadas peticiones detectadas/.test(r.text));
}

const pick = (block, tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';

function parseSearch(xml) {
  return [...xml.matchAll(/<keyword>([\s\S]*?)<\/keyword>/g)]
    .map((m) => ({ shown: stripTags(pick(m[1], 'nombreMostrar')), norm: stripTags(pick(m[1], 'nombreNorm')) }))
    .filter((k) => k.norm);
}

// Value of a two-cell row in the company page table, e.g. <td>Localidad</td><td>Albalat</td>.
function row(html, label) {
  const m = html.match(new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

function parseDetail(html) {
  const name = row(html, 'Denominaci&oacute;n');
  if (!name) return null;
  const sales = (decode(html).match(/facturaci[oó]n de ([\d.,]+)\s*€/i) || [])[1] || '';
  return {
    name,
    legal_form: row(html, 'Forma Jur&iacute;dica'),
    address: row(html, 'Domicilio Social'),
    locality: row(html, 'Localidad'),
    activity: row(html, 'Actividad'),
    share_capital: row(html, 'Capital Social'),
    sales: sales ? `${sales} €` : '',
    ranking_national: row(html, 'Ranking Nacional'),
    ranking_province: row(html, 'Ranking Provincial'),
    ranking_sector: row(html, 'Ranking Sectorial'),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const inputKey = keyOf(keyword || '');
    if (!inputKey) return out('couldnt_check', 'other', BASE, 'empty company name');

    // Query 1: the name without legal form. Query 2 (only if time allows): also without connecting words.
    const queries = [coreTokens(keyword).join(' ')];
    if (inputKey !== queries[0]) queries.push(inputKey);

    let matches = [];
    let answered = 0;
    let skipped = false;
    let lastSource = BASE + SEARCH_PATH;
    for (let i = 0; i < queries.length; i++) {
      if (i > 0 && Date.now() - started > 8000) { skipped = true; break; }
      const url = BASE + SEARCH_PATH + encodeURIComponent(queries[i]);
      lastSource = url;
      const r = await get(url);
      if (blockedResponse(r)) return out('couldnt_check', 'blocked', url, `HTTP ${r.status}: the site refused the search`);
      if (r.status !== 200) return out('couldnt_check', 'http_error', url, `HTTP ${r.status}`);
      if (!r.text.includes('<keywords')) return out('couldnt_check', 'layout_changed', url, r.text.slice(0, 300));
      answered++;
      const hits = parseSearch(r.text).filter((k) => keyOf(k.shown || k.norm) === inputKey);
      if (hits.length) { matches = hits.slice(0, 3); break; }
    }

    if (!matches.length) {
      if (skipped) return out('couldnt_check', 'timeout', lastSource, 'second search skipped to stay under 60 s');
      return out('not_found', '', lastSource, `search answered ${answered} time(s); no listed company matches "${keyword}"`);
    }

    // Each match has its own company page, named by the site's normalised name.
    const details = await Promise.all(matches.map(async (m) => {
      const url = `${BASE}/${encodeURIComponent(m.norm.replace(/\s+/g, '-'))}.html`;
      const r = await get(url);
      if (blockedResponse(r)) return { blocked: true, url, status: r.status };
      if (r.status !== 200) return { error: 'http_error', url, excerpt: `HTTP ${r.status}` };
      const d = parseDetail(r.text);
      if (!d) return { error: 'layout_changed', url, excerpt: stripTags(r.text).slice(0, 300) };
      return { url, d };
    }));

    const blocked = details.find((x) => x.blocked);
    if (blocked) return out('couldnt_check', 'blocked', blocked.url, `HTTP ${blocked.status}: the site refused the company page`);
    const good = details.filter((x) => !x.error && keyOf(x.d.name) === inputKey);
    if (!good.length) {
      const bad = details.find((x) => x.error);
      return out('couldnt_check', bad ? bad.error : 'layout_changed', bad ? bad.url : lastSource, bad ? bad.excerpt : 'company page does not match the search result');
    }

    return {
      status: 'found',
      reason: '',
      records: good.map((x) => x.d),
      source_url: good[0].url,
      excerpt: `${good[0].d.name} | ${good[0].d.activity} | ${good[0].d.locality}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', BASE + SEARCH_PATH, String((err && err.message) || err));
  }
}
