export const meta = {
  task: 'AR-iram.org.ar',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'certification_type', 'code', 'standard', 'scope', 'product', 'certificate_no', 'brand', 'model', 'programme', 'dc_qa'],
  canary: { found: 'IMPLANTEC S.A.', not_found: 'Zqxwvb Inexistente S.A.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_URL = 'https://www.iram.org.ar/certificaciones-otorgadas/';
const AJAX_URL = 'https://www.iram.org.ar/wp-admin/admin-ajax.php';
const timeout = () => AbortSignal.timeout(25000);

// The certification types the site's own search form offers (the page's <select name="certification_type">).
const TYPES = [
  { value: 'sistemasdegestion', label: 'Sistemas de gestión' },
  { value: 'productoscertificados', label: 'Productos' },
  { value: 'agroalimentos', label: 'Agroalimentos' },
  { value: 'renuncias', label: 'Cancelaciones, Renuncias y Suspensiones' },
];

// Result-table headers we keep, mapped to record keys. Unknown headers are dropped.
const HEADER_KEYS = {
  'Código': 'code', 'Certificado No.': 'certificate_no', 'Norma': 'standard', 'Alcance': 'scope',
  'Producto': 'product', 'Marca': 'brand', 'Modelo': 'model', 'Programa': 'programme', 'DC/QA': 'dc_qa',
};

// Spanish legal-form endings, removed from the end of a name before comparing.
const LEGAL_TAIL = /(?:\s(?:sociedad de responsabilidad limitada|sociedad anonima|s a c i f i a|s a c i f i|s a c i f|s a c i|s a c|sacifia|sacifi|sacif|saci|sac|s a s|s a u|s a|s r l|s l|s c a|s c s|ltda|limitada|srl|sas|sau|sl|sa))+$/;

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameKey(s) {
  return fold(s).replace(LEGAL_TAIL, '').trim();
}

// Exact match on the normalised name (case, accents, punctuation, legal form ignored).
// The site writes some companies as "LEGAL NAME S.A. - TRADE NAME", so both parts count.
function rowMatches(keyword, rowName) {
  const want = nameKey(keyword);
  if (!want) return false;
  const full = String(rowName || '');
  const candidates = new Set([nameKey(full), ...full.split(/\s[-–]\s/).map(nameKey)]);
  return candidates.has(want);
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#8217;|&rsquo;/gi, "'").replace(/&#8211;|&ndash;/gi, '-')
    .replace(/\s+/g, ' ').trim();
}

function parseTable(tableHtml) {
  const headers = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cleanText(m[1]));
  const rows = [];
  for (const tr of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanText(m[1]));
    if (cells.length) rows.push(cells);
  }
  return { headers, rows };
}

function isTimeout(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/** Runs the site's own certification search for one type. Returns { type, headers, rows } or { type, error }. */
async function searchType(type, term, nonce, pageId) {
  try {
    const body = new URLSearchParams({
      action: 'cd_ajax_request',
      _controller: 'PageSearchCertification',
      _method: 'search_certification',
      _nonce: nonce,
      '_additional_data[page_id]': String(pageId),
      certification_type: type.value,
      search_value: term,
    });
    const res = await fetch(AJAX_URL, {
      method: 'POST',
      body,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE_URL,
      },
      signal: timeout(),
    });
    if (res.status === 403 || res.status === 429) return { type, error: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
    if (!res.ok) return { type, error: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      if (/captcha|cf-chl|challenge/i.test(text)) return { type, error: { reason: 'blocked', excerpt: 'bot check page' } };
      return { type, error: { reason: 'layout_changed', excerpt: text.slice(0, 300) } };
    }
    if (!data || data.success !== true) {
      return { type, error: { reason: 'other', excerpt: 'search answered without success: ' + text.slice(0, 200) } };
    }
    // The site answers success with no results_table when nothing matches.
    if (!data.results_table) return { type, headers: [], rows: [] };
    if (typeof data.results_table !== 'string' || !/<table[\s>]/i.test(data.results_table)) {
      return { type, error: { reason: 'layout_changed', excerpt: String(data.results_table).slice(0, 300) } };
    }
    const tableHtml = data.results_table.match(/<table[\s\S]*?<\/table>/i)[0];
    return { type, ...parseTable(tableHtml) };
  } catch (e) {
    return { type, error: { reason: isTimeout(e) ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 300) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    const term = nameKey(name);
    if (term.length < 3) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
        excerpt: 'name too short to search (the site needs at least 3 letters)' };
    }

    // Step 1: the search page carries the token (nonce) and page id that the site's own search sends.
    const pageRes = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: timeout(),
    });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${pageRes.status}` };
    }
    if (!pageRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${pageRes.status}` };
    }
    const html = await pageRes.text();
    const m = html.match(/search_certification_object\s*=\s*(\{[\s\S]*?\});/);
    let cfg = null;
    try { cfg = m ? JSON.parse(m[1]) : null; } catch { cfg = null; }
    const nonce = cfg?._nonce;
    const pageId = cfg?._additional_data?.page_id;
    if (!nonce || !pageId) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL,
        excerpt: 'search token not found on the certificates page' };
    }

    // Step 2: run the site's search for each certification type, in parallel.
    const results = await Promise.all(TYPES.map((t) => searchType(t, term, nonce, pageId)));

    const records = [];
    for (const r of results) {
      if (r.error) continue;
      r.rows.forEach((cells) => {
        if (!rowMatches(name, cells[0])) return;
        const rec = { name: cells[0], certification_type: r.type.label };
        for (let i = 1; i < cells.length; i++) {
          const key = HEADER_KEYS[r.headers[i]];
          if (key && cells[i]) rec[key] = cells[i];
        }
        records.push(rec);
      });
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: PAGE_URL,
        excerpt: records.slice(0, 3).map((r) => Object.values(r).join(' | ')).join(' || ').slice(0, 500),
      };
    }

    // No match. Only a clean answer from every type counts as not_found; a refused type is never "not listed".
    const errors = results.filter((r) => r.error);
    if (errors.length) {
      return {
        status: 'couldnt_check',
        reason: errors[0].error.reason,
        records: [],
        source_url: PAGE_URL,
        excerpt: errors.map((e) => `${e.type.label}: ${e.error.reason} (${e.error.excerpt})`).join('; ').slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `0 matching records for "${name}" in: ${TYPES.map((t) => t.label).join('; ')}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: isTimeout(err) ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
