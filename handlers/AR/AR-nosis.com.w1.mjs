export const meta = { task: 'AR-nosis.com', want: 'w1', tier: 2, method: 'form_post', pdf: false, input: 'company name',
  fields: ['name', 'cuit', 'activity', 'province'], canary: { found: 'Ypf SA', not_found: 'Zqxvwk Inexistente Sociedad Anonima' } };

// The public search box on https://www.nosis.com (homepage) sends the name to informes.nosis.com/Home/Buscar as a form
// POST and gets JSON back. The user-facing search page for the same query is SEARCH_PAGE + the name.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_PAGE = 'https://informes.nosis.com/?source=SitioNosis&q=';
const SEARCH_POST = 'https://informes.nosis.com/Home/Buscar';

// Legal-form words, removed from both sides before the names are compared (so "YPF S.A." matches "Ypf SA").
const LEGAL_FORMS = /\b(sociedad anonima unipersonal|sociedad anonima|sociedad de responsabilidad limitada|sociedad por acciones simplificada|sociedad en comandita por acciones|sociedad en comandita simple|sociedad colectiva|sociedad civil|sociedad de hecho|asociacion civil|cooperativa de trabajo|s a|s r l|sa|srl|sas|sau|sca|sc|ltda|limitada|cia|compania)\b/g;

/** Normalised comparison key: no accents, no case, no punctuation, no spaces, no legal form. */
function nameKey(str) {
  const s = (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return s.replace(LEGAL_FORMS, ' ').replace(/\s+/g, '').trim();
}

function search(keyword) {
  const body = new URLSearchParams({ Texto: keyword, Tipo: '-1', EdadDesde: '-1', EdadHasta: '-1', IdProvincia: '-1', Localidad: '' });
  return fetch(SEARCH_POST, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': SEARCH_PAGE + encodeURIComponent(keyword),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pageUrl = SEARCH_PAGE + encodeURIComponent(keyword);
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: pageUrl, excerpt: String(excerpt).slice(0, 300) });
  try {
    const key = nameKey(keyword);
    if (!key) return fail('other', 'no company name left to search after removing the legal form');

    const res = await search(keyword);
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return fail(/captcha|challenge|access denied/i.test(text) ? 'blocked' : 'layout_changed', text);
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.EntidadesEncontradas)) return fail('layout_changed', text);
    if (data.ExigirCaptcha === true) return fail('blocked', 'the site asks for a captcha before this search');
    if (data.HayError === true) return fail('other', 'the site reported an error for this search');

    const hits = data.EntidadesEncontradas.filter((e) => nameKey(e.RazonSocial) === key);
    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits.map((e) => ({ name: e.RazonSocial, cuit: e.Documento, activity: e.Actividad || '', province: e.Provincia || '' })),
        source_url: pageUrl,
        excerpt: hits.map((e) => `${e.RazonSocial} | CUIT ${e.Documento} | ${e.Provincia || ''}`).join('; ').slice(0, 300),
      };
    }
    // The site shows only part of a longer result list: an absence cannot be confirmed from it.
    if (data.HayMasResultados === true) {
      return fail('other', `the search has more results than the ${data.EntidadesEncontradas.length} shown and none matches the name exactly`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: pageUrl, excerpt: 'the search returned 0 results' };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
