export const meta = { task: 'BR-portal.tcu.gov.br', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'cpf_cnpj', 'tipo_registro', 'municipio', 'uf', 'processo', 'numero_acordao', 'data_acordao',
    'data_transito_julgado', 'data_final_sancao', 'link_deliberacoes', 'link_processo'],
  canary: { found: 'ADVANCIS MAX EQUIPAMENTOS ELETRONICOS LTDA', not_found: 'EMPRESA INEXISTENTE ZZQX LTDA' } };

// TCU "Certidão de licitantes inidôneos" – the public list page posts its filter to this JSON API (no captcha, no login).
const BASE = 'https://certidoes.apps.tcu.gov.br';
const LIST_PAGE = `${BASE}/lista-inidoneos`;
const API = `${BASE}/api/publico/responsaveis-inidoneos-com-paginacao`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const NO_NEW_PAGE_AFTER_MS = 20000; // each fetch may take up to 25 s; keep the whole call under 60 s

// Legal-form words (after normalising) and their canonical form.
const LEGAL_FORMS = { LTDA: 'LTDA', LIMITADA: 'LTDA', SA: 'SA', EIRELI: 'EIRELI', ME: 'ME', EPP: 'EPP', MEI: 'MEI', SS: 'SS' };

/** Upper-case ASCII word tokens; "S.A." / "S/A" become SA, "SOCIEDADE ANONIMA" becomes SA, "&" becomes E. */
function tokens(s) {
  const raw = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/&/g, ' E ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 'S' && raw[i + 1] === 'A') { out.push('SA'); i++; }
    else if (raw[i] === 'SOCIEDADE' && raw[i + 1] === 'ANONIMA') { out.push('SA'); i++; }
    else out.push(raw[i]);
  }
  return out;
}

/** Split a name into its core words and its canonical legal form (trailing legal-form words only). */
function split(name) {
  const t = tokens(name);
  const forms = [];
  while (t.length > 1 && LEGAL_FORMS[t[t.length - 1]]) forms.unshift(LEGAL_FORMS[t.pop()]);
  return { core: t.join(' '), form: forms.join(' ') };
}

/** Same company: normalised core words equal, and the legal form equal when both names state one. */
function sameCompany(keyword, listed) {
  const k = split(keyword);
  const r = split(listed);
  if (!k.core || k.core !== r.core) return false;
  return !k.form || !r.form || k.form === r.form;
}

/** Text sent to the site's search: the name without its trailing legal form. */
function searchTerm(keyword) {
  const words = String(keyword ?? '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS[tokens(words[words.length - 1]).join(' ')]) words.pop();
  return words.join(' ');
}

function toRecord(e) {
  return {
    name: e.nome ?? '',
    cpf_cnpj: e.numeroRegistro ?? '',
    tipo_registro: e.tipoRegistro ?? '',
    municipio: e.municipio ?? '',
    uf: e.uf ?? '',
    processo: e.numeroProcessoFormatado ?? '',
    numero_acordao: e.numeroAcordaoFormatado ?? '',
    data_acordao: e.dataAcordao ?? '',
    data_transito_julgado: e.dataTransitoEmJulgado ?? '',
    data_final_sancao: e.dataFinalSancao ?? '',
    link_deliberacoes: e.linkDeliberacoesProcesso ?? '',
    link_processo: e.linkAcompanhamentoProcesso ?? '',
  };
}

async function searchPage(term, page) {
  return fetch(`${API}?paginaAtual=${page}&tamanhoPagina=${PAGE_SIZE}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parteNome: term }),
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows, Node asserts (exit 127) if the runner calls process.exit while the POST socket is still closing.
  // A short pause after the last fetch lets it close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  let source_url = LIST_PAGE;
  try {
    const term = searchTerm(keyword);
    if (!term) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'empty company name' };
    }
    source_url = `${LIST_PAGE}?nome=${encodeURIComponent(term)}`;

    const matches = [];
    let page = 1;
    let totalPages = 1;
    let totalElements = 0;
    let checked = 0;
    do {
      const res = await searchPage(term, page);
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${res.status}` };
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || !Array.isArray(data.elementos) || typeof data.totalElementos !== 'number') {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
      }
      totalPages = Number(data.totalPaginas) || 1;
      totalElements = data.totalElementos;
      checked += data.elementos.length;
      for (const e of data.elementos) {
        if (sameCompany(keyword, e.nome)) matches.push(toRecord(e));
      }
      page++;
    } while (page <= totalPages && page <= MAX_PAGES && Date.now() - started < NO_NEW_PAGE_AFTER_MS);

    if (matches.length > 0) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url,
        excerpt: `TCU inidôneos list: ${matches.length} record(s) for ${first.name} (${first.cpf_cnpj}), sanction until ${first.data_final_sancao}`,
      };
    }

    if (checked < totalElements) {
      // Results were cut off before the end, so absence cannot be proven.
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url,
        excerpt: `search "${term}" returned ${totalElements} results; checked ${checked} before stopping`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: `0 matching records on the TCU inidôneos list for "${term}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
