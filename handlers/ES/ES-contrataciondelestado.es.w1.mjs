export const meta = {
  task: 'ES-contrataciondelestado.es', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['title', 'document_type', 'date', 'description', 'document_url', 'tender_url', 'matched_phrase'],
  canary: { found: 'FERROVIAL SA', not_found: 'Compañía Inexistente Zzqx S.L.' },
};

// PLACSP public document search (buscador). The company directory ("Empresas") needs a login, so it is not used.
// The search is a JSF form: GET the page for its session cookie and ViewState, then POST the phrase.
// Quoted phrase = exact match on the site's side.

const BASE = 'https://contrataciondelestado.es';
const PAGE = BASE + '/wps/portal/plataforma/buscador';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = () => AbortSignal.timeout(25000);

const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', iquest: '¿', iexcl: '¡', ordf: 'ª', ordm: 'º' };

function clean(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENT ? ENT[n] : m))
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function absUrl(href) {
  return new URL(href.replace(/&amp;/g, '&'), BASE).href;
}

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt };
}

/** Keep cookies from a response (name=value pairs only). */
function takeCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const jar = new Map();
  try {
    const phrase = String(keyword || '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!phrase) return out('couldnt_check', 'other', PAGE, 'empty company name');

    // 1. Search page: session cookie, form field names, ViewState
    const getRes = await fetch(PAGE, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5' }, signal: TIMEOUT() });
    if (getRes.status === 403 || getRes.status === 429) return out('couldnt_check', 'blocked', PAGE, `HTTP ${getRes.status}`);
    if (!getRes.ok) return out('couldnt_check', 'http_error', PAGE, `HTTP ${getRes.status}`);
    const cookie1 = takeCookies(getRes, jar);
    const pageHtml = await getRes.text();

    const form = pageHtml.match(/<form id="(viewns_[^"]+?:j_id_a)"[^>]*action="([^"]+)"/);
    const vs = pageHtml.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    if (!form || !vs || !pageHtml.includes(`name="${form[1]}:boxSearch"`)) {
      if (/captcha|recaptcha|cloudflare/i.test(pageHtml)) return out('couldnt_check', 'blocked', PAGE, clean(pageHtml).slice(0, 300));
      return out('couldnt_check', 'layout_changed', PAGE, clean(pageHtml).slice(0, 300));
    }
    const prefix = form[1];
    const postUrl = absUrl(form[2]);

    // 2. Search POST
    const body = new URLSearchParams();
    body.append(`${prefix}:boxSearch`, `"${phrase}"`);
    body.append(`${prefix}:botonSubmitSearch`, 'Buscar');
    body.append(`${prefix}_SUBMIT`, '1');
    body.append('javax.faces.ViewState', vs[1]);

    const postRes = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': PAGE,
        'Origin': BASE,
        'Cookie': cookie1,
      },
      body: body.toString(),
      signal: TIMEOUT(),
    });
    if (postRes.status === 403 || postRes.status === 429) return out('couldnt_check', 'blocked', PAGE, `HTTP ${postRes.status}`);
    if (!postRes.ok) return out('couldnt_check', 'http_error', PAGE, `HTTP ${postRes.status}`);
    takeCookies(postRes, jar);
    const html = await postRes.text();

    if (/ViewExpired|sesi[oó]n ha caducado/i.test(html)) return out('couldnt_check', 'other', PAGE, 'session expired on the search form');
    if (/captcha|recaptcha/i.test(html) && !/tableResultSearch|No se han obtenido resultados/.test(html)) {
      return out('couldnt_check', 'blocked', PAGE, clean(html).slice(0, 300));
    }

    const hasTable = /:tableResultSearch"/.test(html);
    const noResults = /No se han obtenido resultados/i.test(html);
    if (!hasTable && noResults) {
      return out('not_found', '', PAGE, `No se han obtenido resultados para la búsqueda: "${phrase}"`);
    }
    if (!hasTable) return out('couldnt_check', 'layout_changed', PAGE, clean(html).slice(0, 300));

    // 3. Result rows (one per document; each row names the tender it belongs to)
    const total = (html.match(/de ([\d.,]+) Resultados/) || [])[1] || '';
    const rows = [...html.matchAll(/<tr class="rowClass\d">[\s\S]*?<\/tr>/g)].map((m) => m[0]);
    const records = [];
    for (const row of rows) {
      const title = (row.match(/GetDocumentByIdServlet[\s\S]*?class="commandLink">([\s\S]*?)<\/span>/) || [])[1];
      const type = (row.match(/class="tipo">([\s\S]*?)<\/span>/) || [])[1];
      const desc = (row.match(/textColumnaExpedienteResultado"[^>]*>([\s\S]*?)<\/span>/) || [])[1];
      const date = (row.match(/textColumnaDateResultado"[^>]*>([\s\S]*?)<\/span>/) || [])[1];
      const docHref = (row.match(/href="([^"]*GetDocumentByIdServlet[^"]*)"/) || [])[1];
      const tenderHref = (row.match(/href="([^"]*detalle_licitacion[^"]*)"/) || [])[1];
      if (!title) continue;
      records.push({
        title: clean(title),
        document_type: clean(type).replace(/^\(|\)$/g, ''),
        date: clean(date),
        description: clean(desc),
        document_url: docHref ? absUrl(docHref) : '',
        tender_url: tenderHref ? absUrl(tenderHref) : '',
        matched_phrase: phrase,
      });
    }

    if (records.length === 0) return out('couldnt_check', 'layout_changed', PAGE, clean(html).slice(0, 300));

    return out(
      'found',
      '',
      PAGE,
      `${total || records.length} public tender documents on the site's document search contain the exact phrase "${phrase}". ` +
        'The result list does not show the company register record: the match is on document text only.',
      records,
    );
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return out('couldnt_check', reason, PAGE, String(err?.message || err).slice(0, 300));
  }
}
