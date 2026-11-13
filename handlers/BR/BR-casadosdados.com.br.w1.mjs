export const meta = {
  task: 'BR-casadosdados.com.br',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['cnpj', 'razao_social', 'nome_fantasia', 'situacao_atual', 'matched_on'],
  canary: { found: 'DERIVADOS DE PETROLEO SAO BORJA LTDA', not_found: 'ZZQXWV ARTESANATO IMAGINARIO LTDA' },
};

const API = 'https://api.casadosdados.com.br/v4/public/pesquisa/nome';
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Brazilian legal-form words that are dropped from the end of a name before comparing.
const LEGAL_FORM = new Set(['LTDA', 'LIMITADA', 'SA', 'EIRELI', 'ME', 'EPP', 'MEI', 'SS']);

/** Upper-case, no accents, no punctuation, no trailing legal form: "Acme Ltda." and "ACME LTDA" both become "ACME". */
function normName(str) {
  let t = (str || '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
  t = t.replace(/S\s*\/\s*A\b|S\s*\.\s*A\s*\./g, 'SA');
  t = t.replace(/[^A-Z0-9]+/g, ' ').trim();
  const toks = t.split(' ').filter(Boolean);
  while (toks.length && LEGAL_FORM.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normName(keyword);
    if (!kw) return out('couldnt_check', 'other', [], API, 'empty company name');

    const started = Date.now();
    const firstUrl = `${API}?q=${encodeURIComponent(String(keyword).trim())}&pagina=1`;
    const records = [];
    let total = null;
    let scanned = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      // Do not start another page after 25 s: keeps the whole call well under 60 s.
      if (page > 1 && Date.now() - started >= 25000) break;

      const url = `${API}?q=${encodeURIComponent(String(keyword).trim())}&pagina=${page}`;
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://casadosdados.com.br/' },
          signal: AbortSignal.timeout(25000),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (records.length) break; // a match is already in hand; keep it
        return out('couldnt_check', timedOut ? 'timeout' : 'other', [], firstUrl, String(err?.message || err));
      }

      if (res.status === 401 || res.status === 403 || res.status === 429) {
        if (records.length) break;
        return out('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        if (records.length) break;
        return out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`);
      }

      const body = await res.text();
      let json;
      try { json = JSON.parse(body); } catch { json = null; }
      if (!json || !Array.isArray(json.cnpjs) || typeof json.total !== 'number') {
        if (/captcha|challenge|turnstile|cf-chl/i.test(body)) {
          if (records.length) break;
          return out('couldnt_check', 'blocked', [], url, body.slice(0, 200));
        }
        if (records.length) break;
        return out('couldnt_check', 'layout_changed', [], url, body.slice(0, 200));
      }

      total = json.total;
      scanned += json.cnpjs.length;
      for (const c of json.cnpjs) {
        const byRazao = normName(c.razao_social) === kw;
        const byFantasia = !!c.nome_fantasia && normName(c.nome_fantasia) === kw;
        if (byRazao || byFantasia) {
          records.push({
            cnpj: String(c.cnpj || ''),
            razao_social: c.razao_social || '',
            nome_fantasia: c.nome_fantasia || '',
            situacao_atual: c.situacao_cadastral?.situacao_atual || '',
            matched_on: byRazao ? 'razao_social' : 'nome_fantasia',
          });
        }
      }

      // Last page reached: the search has no more results.
      if (json.cnpjs.length < PAGE_SIZE || scanned >= total) break;
    }

    if (records.length) {
      return out('found', '', records, firstUrl, JSON.stringify(records.slice(0, 3)));
    }
    if (total === 0) {
      return out('not_found', '', [], firstUrl, `search returned 0 results for "${keyword}"`);
    }
    // Results exist but no exact name match in the part we read: absence is not proven.
    return out('couldnt_check', 'other', [], firstUrl,
      `no exact name match in the first ${scanned} of ${total} search results for "${keyword}"`);
  } catch (err) {
    return out('couldnt_check', 'other', [], API, String(err?.message || err));
  }
}
