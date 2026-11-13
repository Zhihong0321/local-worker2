export const meta = {
  task: 'ES-enac.es',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'scopes', 'scope_documents'],
  canary: { found: 'AENOR CONFÍA, S.A. (Unipersonal)', not_found: 'Zxqwv Ficticia Ensayos S.L.' },
};

const PAGE = 'https://www.enac.es/entidades-acreditadas/buscador-de-acreditados';
const SEARCH = PAGE
  + '?p_p_id=buscadoralcances_WAR_BuscadorAlcancesportlet&p_p_lifecycle=1&p_p_state=normal&p_p_mode=view'
  + '&p_p_col_id=column-1&p_p_col_count=1'
  + '&_buscadoralcances_WAR_BuscadorAlcancesportlet_javax.portlet.action=searchURL';
const ORIGIN = 'https://www.enac.es';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NONE_TEXT = 'No se han encontrado resultados';
// Spanish legal-form words that the site's own name does not need for matching.
const LEGAL_WORDS = new Set(['sa', 'sl', 'slu', 'sll', 'sau', 'scp', 'unipersonal', 'sociedad', 'anonima', 'limitada', 's', 'a', 'l', 'u']);

/** Lower case, accents and punctuation removed. */
function fold(str) {
  return (str || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The name without legal form: "ACME, S.L." and "ACME" give the same core. */
function core(str) {
  return fold(str).split(' ').filter((t) => t && !LEGAL_WORDS.has(t)).join(' ');
}

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** Session cookies from the Set-Cookie headers, to send back with the search. */
function cookieHeader(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  return list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = core(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    // Step 1: open the search page. It sets the session cookies the search needs (without them the site answers 502)
    // and holds the form token.
    const page = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (page.status === 403 || page.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${page.status}` };
    }
    if (!page.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${page.status}` };
    }
    const pageHtml = await page.text();
    if (!pageHtml.includes('_buscadoralcances_WAR_BuscadorAlcancesportlet_keywords')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: clean(pageHtml).slice(0, 300) };
    }
    const cookie = cookieHeader(page.headers);
    const formDate = pageHtml.match(/name="_buscadoralcances_WAR_BuscadorAlcancesportlet_formDate"[^>]*value="(\d+)"/)?.[1] || '';

    // Step 2: the search form POST. The site matches plain words (no accents, no punctuation, no legal form).
    const body = new URLSearchParams({
      _buscadoralcances_WAR_BuscadorAlcancesportlet_formDate: formDate,
      _buscadoralcances_WAR_BuscadorAlcancesportlet_keywords: wanted.toUpperCase(),
    });
    const res = await fetch(SEARCH, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': ORIGIN,
        'Referer': PAGE,
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const hasNone = html.includes(NONE_TEXT);
    const chunks = html.split('<div class="search-result">').slice(1);

    // Each result row: <div class="search-result"><div class="title">NAME</div> ... <a href="/documents/..">scope</a> ... <p>ADDRESS</p>
    const rows = [];
    for (const chunk of chunks) {
      const t = chunk.match(/<div class="title">([\s\S]*?)<\/div>/);
      if (!t) continue;
      const title = clean(t[1]);
      const address = clean(chunk.match(/<p>([\s\S]*?)<\/p>/)?.[1] || '');
      const docs = [...chunk.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .filter((m) => m[1].startsWith('/documents/'))
        .map((m) => ({ url: new URL(m[1], ORIGIN).href, scope: clean(m[2]) }));
      // Some rows are the same entity's laboratory scope, written as "NAME.Laboratorio".
      rows.push({ name: title.replace(/\.\s*laboratorio\s*$/i, '').trim(), address, docs });
    }

    if (!hasNone && rows.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: clean(html).slice(0, 300) };
    }

    const matches = rows.filter((r) => core(r.name) === wanted);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: hasNone ? `${NONE_TEXT} for ${wanted}` : `search returned ${rows.length} rows, none named ${wanted}`,
      };
    }

    // One record per entity, with all its accreditation scopes.
    const byName = new Map();
    for (const r of matches) {
      if (!byName.has(r.name)) byName.set(r.name, { name: r.name, address: r.address, scopes: [], scope_documents: [] });
      const rec = byName.get(r.name);
      if (!rec.address && r.address) rec.address = r.address;
      for (const d of r.docs) {
        if (!rec.scope_documents.includes(d.url)) {
          rec.scope_documents.push(d.url);
          rec.scopes.push(d.scope);
        }
      }
    }
    const records = [...byName.values()];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE,
      excerpt: records.map((r) => `${r.name} | ${r.address}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
