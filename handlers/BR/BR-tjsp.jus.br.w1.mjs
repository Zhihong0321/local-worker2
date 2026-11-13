export const meta = {
  task: 'BR-tjsp.jus.br',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'role', 'process_number', 'court_class', 'subject', 'distributed', 'court_unit', 'url'],
  canary: { found: 'PETROBRAS S.A.', not_found: 'Empresa Fantasma Inexistente Zqxwv Ltda' },
};

// e-SAJ (TJSP) party-name search. A plain GET with the name in the query string returns the result page directly
// (no login, no captcha, no session cookie needed). Results list each process with the party name that matched.
const SEARCH = 'https://esaj.tjsp.jus.br/cpopg/search.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form tokens dropped before comparing names: "PETROBRAS S.A." = "Petrobras S/A" = "PETROBRAS".
const LEGAL_FORM = new Set(['sa', 's', 'a', 'ltda', 'ltd', 'limited', 'eireli', 'me', 'epp', 'ss', 'sdn', 'bhd', 'inc', 'llc', 'corp']);
const NO_RESULTS = /Não existem informações disponíveis para os parâmetros informados/i;

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normalised core name: no accents, case, punctuation or legal form. */
function coreName(s) {
  return stripAccents(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter((t) => t && !LEGAL_FORM.has(t)).join(' ');
}

function clean(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = stripAccents(keyword).replace(/\s+/g, ' ').trim();
    if (!query) return fail('other', SEARCH, 'empty company name');

    const url = new URL(SEARCH);
    url.search = new URLSearchParams({
      cbPesquisa: 'NMPARTE',
      'dadosConsulta.valorConsulta': query,
      chNmCompleto: 'true',
      'dadosConsulta.tipoNuProcesso': 'SAJ',
      cdForo: '-1',
      paginaConsulta: '1',
      'dadosConsulta.nmParte': query,
    }).toString();
    const sourceUrl = url.href;

    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return fail(timeout ? 'timeout' : 'other', sourceUrl, String(e));
    }
    if (res.status === 403 || res.status === 429) return fail('blocked', sourceUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', sourceUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const countMatch = html.match(/(\d[\d.]*)\s+Processos?\s+encontrados?/i);
    const empty = NO_RESULTS.test(html);

    if (!countMatch && !empty) {
      if (/sajcas\/login|captcha|recaptcha|hcaptcha|acesso negado/i.test(html)) {
        return fail('blocked', sourceUrl, 'login or bot-check page');
      }
      return fail('layout_changed', sourceUrl, html.slice(0, 300));
    }
    if (!countMatch) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: 'Não existem informações disponíveis para os parâmetros informados' };
    }

    const total = parseInt(countMatch[1].replace(/\./g, ''), 10) || 0;

    // One <li> per process; only the result rows carry class "nuProcesso col-md-3".
    const rows = [];
    for (const block of html.split(/<li>/i)) {
      if (!/class="nuProcesso col-md-3"/.test(block)) continue;
      const link = block.match(/<a href="(\/cpopg\/show\.do[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const party = block.match(/tipoDeParticipacao">([\s\S]*?)<\/label>[\s\S]*?nomeParte">([\s\S]*?)<\/div>/i);
      const cls = block.match(/classeProcesso">([\s\S]*?)<\/div>/i);
      const subject = block.match(/assuntoPrincipalProcesso">([\s\S]*?)<\/div>/i);
      const dist = block.match(/dataLocalDistribuicaoProcesso">([\s\S]*?)<\/div>/i);
      if (!link || !party) continue;
      rows.push({
        name: clean(party[2]),
        role: clean(party[1]).replace(/:$/, ''),
        process_number: clean(link[2]),
        court_class: cls ? clean(cls[1]) : '',
        subject: subject ? clean(subject[1]) : '',
        distributed: dist ? clean(dist[1]).split(' - ')[0] : '',
        court_unit: dist ? clean(dist[1]).split(' - ').slice(1).join(' - ') : '',
        url: new URL(link[1].replace(/&amp;/gi, '&'), 'https://esaj.tjsp.jus.br').href,
      });
    }

    if (total > 0 && rows.length === 0) {
      return fail('layout_changed', sourceUrl, `${total} results reported but no result rows parsed`);
    }

    const want = coreName(keyword);
    const matches = rows.filter((r) => want && coreName(r.name) === want);

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: `${total} process(es) for this name; ${matches.length} on the first page list "${matches[0].name}" as ${matches[0].role}`,
      };
    }

    if (total > rows.length) {
      return fail('other', sourceUrl,
        `${total} results, but none on the first page (${rows.length} shown) name this company; later pages not read`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
      excerpt: `${total} process(es) returned, none names this company` };
  } catch (e) {
    return fail('other', SEARCH, 'the handler threw: ' + String(e).slice(0, 250));
  }
}
