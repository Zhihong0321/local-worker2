export const meta = {
  task: 'AR-cnv.gov.ar',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cuit', 'cucnv', 'page_name', 'status', 'detail_url'],
  canary: { found: 'YPF S.A.', not_found: 'Inexistente Zqxwvt S.A.' },
};

const BASE = 'https://www.cnv.gov.ar/SitioWeb/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'application/json, text/javascript, text/html, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
};
// Argentine legal forms, matched on the normalised (accent-free, lower-case, no punctuation) string.
const LEGAL = /\b(sociedad de responsabilidad limitada|sociedad anonima unipersonal|sociedad anonima|sociedad por acciones simplificada|sociedad en comandita por acciones|sociedad en comandita simple|sociedad colectiva|s a s|s a u|s a|s r l|s c a|s c s|s g r|s c|sa|sau|srl|sas|sca|scs|sgr|sc)\b/g;

/** Same name in a comparable form: no accents, case, punctuation or legal form. */
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCuit(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : d;
}

/** Search terms: the name without legal form, the name as typed, then its longest words (the site misses some full names). */
function searchTerms(keyword) {
  const base = normName(keyword);
  const terms = [];
  const add = (t) => { const v = String(t || '').trim(); if (v && !terms.includes(v)) terms.push(v); };
  add(base);
  add(keyword);
  base.split(' ').filter((w) => w.length >= 3).sort((a, b) => b.length - a.length).slice(0, 2).forEach(add);
  return { base, terms: terms.slice(0, 4) };
}

function failKind(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** One call to the same autocomplete the CNV search box uses. Returns { items } or { fail, excerpt }. */
async function autocomplete(term) {
  const url = `${BASE}Empresas/AutoComplete?term=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { url, fail: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { url, fail: 'http_error', excerpt: `HTTP ${res.status}` };
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { data = null; }
    if (!Array.isArray(data)) {
      const walled = /captcha|access denied|forbidden|bot/i.test(body.slice(0, 5000));
      return { url, fail: walled ? 'blocked' : 'layout_changed', excerpt: body.slice(0, 200) };
    }
    return { url, items: data.filter((x) => x && typeof x.descripcion === 'string') };
  } catch (err) {
    return { url, fail: failKind(err), excerpt: String(err?.message || err).slice(0, 200) };
  }
}

/** The company page: legal name as the page shows it, regime status and CUIT. Never throws; {} on any problem. */
async function companyPage(cuit) {
  try {
    const res = await fetch(`${BASE}Empresas/Empresa/${cuit}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return {};
    const html = await res.text();
    const at = html.search(/Resultados de b[úu]squeda:/i);
    if (at < 0) return {};
    const seg = html.slice(at, at + 6000);
    const h1 = seg.match(/<h1>([\s\S]*?)<\/h1>/i);
    const page_name = h1 ? clean(h1[1].split(/<small>/i)[0]) : '';
    const status = h1
      ? (h1[1].match(/<strong>[\s\S]*?<\/strong>/gi) || []).map(clean).filter(Boolean).join(' | ')
      : '';
    return { page_name, status };
  } catch {
    return {};
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  const { base, terms } = searchTerms(input);
  const searchUrl = `${BASE}Empresas/AutoComplete?term=${encodeURIComponent(base || input)}`;
  try {
    if (!base) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    let matches = [];
    let answered = false;
    let skipped = false;
    let firstUrl = '';
    for (const term of terms) {
      if (Date.now() - started > 30000) { skipped = true; break; }
      const r = await autocomplete(term);
      if (!firstUrl) firstUrl = r.url;
      if (r.fail) {
        return { status: 'couldnt_check', reason: r.fail, records: [], source_url: r.url, excerpt: r.excerpt };
      }
      answered = true;
      matches = r.items.filter((it) => normName(it.descripcion) === base);
      if (matches.length) break;
    }

    if (!answered) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: 'no answer from the search' };
    }

    if (!matches.length) {
      if (skipped) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: firstUrl, excerpt: 'search ran out of time before every term was tried' };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `CNV company search returned no company named "${input}" (terms: ${terms.join(' | ')})`,
      };
    }

    const records = [];
    for (const m of matches.slice(0, 3)) {
      const cuit = String(m.cuit || '').replace(/\D/g, '');
      const rec = {
        name: String(m.descripcion).trim(),
        cuit: formatCuit(cuit),
        cucnv: m.id,
        page_name: '',
        status: '',
        detail_url: cuit ? `${BASE}Empresas/Empresa/${cuit}` : '',
      };
      if (cuit && Date.now() - started < 25000) {
        Object.assign(rec, await companyPage(cuit));
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].detail_url || firstUrl,
      excerpt: records.map((r) => `${r.name} | CUIT ${r.cuit}${r.status ? ' | ' + r.status : ''}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
