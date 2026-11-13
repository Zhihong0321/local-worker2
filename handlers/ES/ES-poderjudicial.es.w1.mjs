export const meta = {
  task: 'ES-poderjudicial.es',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['ecli', 'title', 'decision_date', 'chamber', 'municipality', 'ponente', 'case_number', 'resolution_number', 'database', 'summary', 'judgment_url'],
  canary: { found: 'Telefónica de España SAU', not_found: 'Sociedad Inexistente Ficticia Qwerty S.L.' },
};

// CENDOJ case-law search. The search answers only after a session cookie is fetched from the
// search front page (a request with no cookie gets 403). Searches go to the Supreme Court (TS)
// and the National Court (AN) databases. Judgment texts sit behind a captcha, so the handler
// reads only the result list: the editorial summary (RESUMEN) of each judgment.

const HOME = 'https://www.poderjudicial.es/search/index.jsp';
const SEARCH = 'https://www.poderjudicial.es/search/search.action';
const DATABASES = ['TS', 'AN'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' };

// Legal-form words. Stripped from the END of the name only, so the core name is compared.
// Kept to forms that are not ordinary words ("se", "as", "co" are left out on purpose).
const LEGAL = new Set(['sa', 'sau', 'sl', 'slu', 'sll', 'slne', 'sas', 'sasu', 'scl', 'sc', 'coop', 'sociedad', 'anonima',
  'limitada', 'unipersonal', 'ltd', 'limited', 'llc', 'inc', 'plc', 'gmbh', 'ag', 'bv', 'nv', 'srl', 'spa', 'sarl',
  'sdn', 'bhd', 'pte', 'pty', 'corp', 'corporation', 'company', 'ab', 'oy', 'asa']);

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ordm: 'º', ordf: 'ª', ntilde: 'ñ', Ntilde: 'Ñ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ccedil: 'ç' };

function decode(s) {
  return (s || '')
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised words: no accents, lower case, no dots/apostrophes, other punctuation as spaces. */
function toWords(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[.'’`´"]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** The company's core name: its words without the trailing legal form. */
function coreWords(keyword) {
  const w = toWords(keyword);
  let end = w.length;
  while (end > 0 && LEGAL.has(w[end - 1])) end--;
  return w.slice(0, end);
}

/**
 * True when the summary names the company: the core name, then a legal form (or the end of the summary).
 * The legal form is what stops a bare word from matching: "Telefonica" alone is also an ordinary word
 * ("llamada telefonica"), but "Telefonica SA" is a company. "Telefonica de Espana" does not match "Telefonica SA".
 */
function namesCompany(core, summary) {
  const w = toWords(summary);
  for (let i = 0; i + core.length <= w.length; i++) {
    let same = true;
    for (let k = 0; k < core.length; k++) {
      if (w[i + k] !== core[k]) { same = false; break; }
    }
    if (same) {
      const next = w[i + core.length];
      if (next === undefined || LEGAL.has(next)) return true;
    }
  }
  return false;
}

function field(block, re) {
  const m = block.match(re);
  return m ? cleanText(m[1]) : '';
}

/** Parse the result list of one search page into records. */
function parseResults(html, db) {
  const blocks = html.split('class="row searchresult doc"').slice(1);
  return blocks.map((block) => {
    const title = field(block, /<div class="title">([\s\S]*?)<\/div>/);
    const fres = (block.match(/data-fechares="(\d{8})"/) || [])[1] || '';
    const summaryHtml = (block.match(/<div class="summary" id="jur-summary-\d+">([\s\S]*?)<\/div>/) || [])[1] || '';
    const summary = cleanText(summaryHtml).replace(/^(?:RESUMEN|Resumen Autom[aá]tico):\s*/i, '');
    const link = (block.match(/data-link="([^"]+)"/) || [])[1] || '';
    return {
      ecli: field(block, /<b>(ECLI:[^<]+)<\/b>/),
      title,
      decision_date: fres ? `${fres.slice(0, 4)}-${fres.slice(4, 6)}-${fres.slice(6, 8)}` : '',
      chamber: field(block, /<b>((?:Sala|Secci)[^<]*)<\/b>/),
      municipality: field(block, /Municipio:\s*<b>([^<]+)<\/b>/),
      ponente: field(block, /Ponente:\s*<b>([^<]+)<\/b>/),
      case_number: field(block, /N&ordm; Recurso:\s*<b>([^<]+)<\/b>/),
      resolution_number: field(block, /de Resoluci&oacute;n:\s*<b>([^<]+)<\/b>/),
      database: db,
      summary,
      judgment_url: decode(link),
    };
  });
}

/** One search of one database. Never throws. */
async function searchDb(db, core, cookie) {
  const url = `${SEARCH}?action=query&sort=IN_FECHARESOLUCION%3Adecreasing&recordsPerPage=50&start=1&databasematch=${db}` +
    `&TEXT=${encodeURIComponent('"' + core.join(' ') + '"')}`;
  const out = { db, url, count: null, zero: false, records: [], reason: '', excerpt: '' };
  try {
    const headers = { ...BASE_HEADERS, 'Referer': HOME };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    if (res.status === 403 || res.status === 429) return { ...out, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ...out, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    if (/captcha|no tiene permisos/i.test(html)) return { ...out, reason: 'blocked', excerpt: 'captcha or access refused page' };
    if (/No se ha encontrado ning(?:&uacute;|ú)n resultado/i.test(html)) return { ...out, zero: true, count: 0 };
    const countMatch = html.match(/(\d[\d.]*)\s+resultados?\b/i);
    if (!countMatch && !html.includes('searchresults')) {
      return { ...out, reason: 'layout_changed', excerpt: cleanText(html).slice(0, 300) };
    }
    const count = countMatch ? Number(countMatch[1].replace(/\./g, '')) : 0;
    return { ...out, count, records: parseResults(html, db) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ...out, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceFallback = `${SEARCH}?action=query&databasematch=TS&TEXT=${encodeURIComponent(String(keyword || ''))}`;
  try {
    const core = coreWords(String(keyword || ''));
    if (core.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceFallback, excerpt: 'no company name in the input' };
    }

    // Step 1: session cookie from the search front page.
    const home = await fetch(HOME, { headers: BASE_HEADERS, signal: AbortSignal.timeout(25000) });
    await home.text().catch(() => '');
    if (home.status === 403 || home.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: HOME, excerpt: `HTTP ${home.status} on the search front page` };
    }
    if (!home.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: HOME, excerpt: `HTTP ${home.status} on the search front page` };
    }
    const setCookies = typeof home.headers.getSetCookie === 'function'
      ? home.headers.getSetCookie()
      : [home.headers.get('set-cookie') || ''].filter(Boolean);
    const cookie = setCookies.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');

    // Step 2: the phrase search in each database, in parallel.
    const results = await Promise.all(DATABASES.map((db) => searchDb(db, core, cookie)));

    // The same judgment can come back from both databases: keep one record per ECLI (or link).
    const records = [];
    const seen = new Set();
    let firstMatchUrl = '';
    let unmatched = 0;
    for (const r of results) {
      for (const rec of r.records) {
        if (!namesCompany(core, rec.summary)) { unmatched++; continue; }
        const key = rec.ecli || rec.judgment_url;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(rec);
        if (!firstMatchUrl) firstMatchUrl = r.url;
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstMatchUrl,
        excerpt: records[0].summary.slice(0, 300),
      };
    }

    const errored = results.find((r) => r.reason);
    if (errored) {
      return { status: 'couldnt_check', reason: errored.reason, records: [], source_url: errored.url, excerpt: `${errored.db}: ${errored.excerpt}` };
    }

    const total = results.reduce((s, r) => s + (r.count || 0), 0);
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: results[0].url, excerpt: `0 results in ${DATABASES.join(', ')}` };
    }

    // Judgments contain the words, but no visible summary names the company: a judgment text
    // would be needed, and those are behind a captcha.
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: results[0].url,
      excerpt: `${total} judgment(s) contain the name; ${unmatched} checked, none names the company in its summary. Full texts are behind a captcha.`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other',
      records: [],
      source_url: sourceFallback,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
