export const meta = {
  task: 'BR-bcb.gov.br',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'unformatted_name', 'cnpj', 'type', 'status', 'legal_nature', 'short_name', 'trade_name', 'state', 'city', 'sisbacen_code', 'database'],
  canary: { found: 'BANCO DO BRASIL S.A.', not_found: 'Empresa Inexistente de Teste Ltda' },
};

// BCB open data (Olinda, BcBase v2): "Dados cadastrais de entidades supervisionadas".
// The function takes a snapshot date as MM-DD-YYYY and supports an OData $filter with contains().
// The filter is case-sensitive and the data is upper case with accents, so the search term is sent upper case.
const BASE = 'https://olinda.bcb.gov.br/olinda/servico/BcBase/versao/v2/odata/EntidadesSupervisionadas';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['LTDA', 'LIMITADA', 'SA', 'ME', 'EPP', 'EIRELI']);

function stripMarks(s) {
  return s.normalize('NFD').replace(/\p{M}+/gu, '');
}

// Name used to compare: no accents, upper case, punctuation and legal form removed.
function normalizeName(s) {
  return stripMarks(String(s || '').toUpperCase())
    .replace(/\bS\s*\.?\s*\/?\s*A\b\.?/g, ' SA ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

// Words of the typed name: the accent-free form (for search) and the upper-case form as typed (keeps accents).
function searchWords(keyword) {
  const cleaned = String(keyword || '').toUpperCase().replace(/\bS\s*\.?\s*\/?\s*A\b\.?/g, ' SA ');
  const pairs = [];
  for (const raw of cleaned.split(/[^\p{L}\p{N}]+/u)) {
    const norm = stripMarks(raw).replace(/[^A-Z0-9]/g, '');
    if (!norm || LEGAL_FORMS.has(norm)) continue;
    pairs.push({ raw, norm });
  }
  return pairs;
}

// Snapshot dates to try: the 1st of this month, then the 1st of last month (used only if this month fails).
function snapshotDates() {
  const now = new Date();
  const fmt = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-01-${d.getUTCFullYear()}`;
  return [
    fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
  ];
}

function queryUrl(date, term) {
  const filter = `contains(nomeEntidadeInteresse,'${term}')`;
  return `${BASE}(dataBase='${date}')?$filter=${encodeURIComponent(filter)}&$format=json`;
}

function failure(err) {
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
}

async function getRows(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return failure(err);
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status} ${body.slice(0, 120)}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    return failure(err);
  }
  if (!json || !Array.isArray(json.value)) {
    return { ok: false, reason: 'layout_changed', excerpt: 'response has no value list' };
  }
  return { ok: true, rows: json.value };
}

function toRecord(r) {
  return {
    name: r.nomeEntidadeInteresse ?? '',
    unformatted_name: r.nomeEntidadeInteresseNaoFormatado ?? '',
    cnpj: r.codigoCNPJ14 ?? '',
    type: r.descricaoTipoEntidadeSupervisionada ?? '',
    status: r.descricaoTipoSituacaoPessoaJuridica ?? '',
    legal_nature: r.descricaoNaturezaJuridica ?? '',
    short_name: r.nomeReduzido ?? '',
    trade_name: r.nomeFantasia ?? '',
    state: r.nomeDaUnidadeFederativa ?? '',
    city: r.nomeDoMunicipio ?? '',
    sisbacen_code: r.codigoSisbacen ?? '',
    database: r.database ?? '',
  };
}

// On the Windows test box (Node 24.19), a process that exits right after a fetch aborts with
// "UV_HANDLE_CLOSING" and exit code 127, even though the answer was already printed. A short pause
// lets the socket close before the caller exits. It costs about half a second.
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  await settle();
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const pairs = searchWords(keyword);
    const target = normalizeName(keyword);
    if (!pairs.length || !target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no usable words in the name' };
    }
    const longest = pairs.reduce((a, b) => (b.norm.length > a.norm.length ? b : a));
    const terms = [...new Set([longest.norm, longest.raw])];

    let last = { reason: 'other', excerpt: 'no attempt made', url: '' };
    for (const date of snapshotDates()) {
      const results = await Promise.all(
        terms.map(async (term) => {
          const url = queryUrl(date, term);
          return { url, ...(await getRows(url)) };
        })
      );
      const failed = results.find((r) => !r.ok);
      if (failed) {
        last = failed;
        continue;
      }

      const rows = new Map();
      for (const r of results) for (const row of r.rows) rows.set(JSON.stringify(row), row);
      const matches = [...rows.values()].filter((row) =>
        [row.nomeEntidadeInteresse, row.nomeEntidadeInteresseNaoFormatado].some((n) => normalizeName(n) === target)
      );
      const sourceUrl = queryUrl(date, longest.norm);

      if (matches.length === 0) {
        return {
          status: 'not_found',
          reason: '',
          records: [],
          source_url: sourceUrl,
          excerpt: `no entry with this name in the BCB list (snapshot ${date}); ${rows.size} entries share the word "${longest.norm}"`,
        };
      }
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: sourceUrl,
        excerpt: `${matches.length} match(es) in BCB list (snapshot ${date}): ${first.nomeEntidadeInteresse} - ${first.descricaoTipoSituacaoPessoaJuridica ?? 'status not given'}`.slice(0, 500),
      };
    }

    return { status: 'couldnt_check', reason: last.reason, records: [], source_url: last.url, excerpt: last.excerpt };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: '',
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
