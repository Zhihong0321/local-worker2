export const meta = {
  task: 'ES-boe.es',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'role', 'borme_issue', 'reference', 'doc_url'],
  canary: { found: 'BOCAIRENT SOLAR, SOCIEDAD LIMITADA', not_found: 'ZZQXVK NOEXISTENTE SOCIEDAD LIMITADA' },
};

// Searches the BORME "Anuncios" search (Seccion II: announcements). Section I (incorporations, appointments)
// has no name search on this site, so a not_found here only means "not in section II".
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://www.boe.es/buscar/anborme.php';
const DOC = 'https://www.boe.es/buscar/doc.php?id=';
const PAGE_HITS = 200;

const LEGAL_CODES = new Set(['SL', 'SLU', 'SA', 'SAU', 'SLP', 'SCOOP']);
// Longest phrases first, so "SOCIEDAD LIMITADA UNIPERSONAL" is not read as "SOCIEDAD LIMITADA".
const LEGAL_PHRASES = [
  ['SOCIEDAD DE RESPONSABILIDAD LIMITADA UNIPERSONAL', 'SLU'],
  ['SOCIEDAD LIMITADA UNIPERSONAL', 'SLU'],
  ['SOCIEDAD DE RESPONSABILIDAD LIMITADA', 'SL'],
  ['SOCIEDAD LIMITADA PROFESIONAL', 'SLP'],
  ['SOCIEDAD LIMITADA', 'SL'],
  ['SOCIEDAD ANONIMA UNIPERSONAL', 'SAU'],
  ['SOCIEDAD ANONIMA', 'SA'],
  ['SOCIEDAD COOPERATIVA', 'SCOOP'],
];

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/** Normalised name: no accents, case or punctuation; legal form split off as a code (SL, SA, ...). */
function nameKey(s) {
  let t = fold(s).replace(/\./g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [phrase, code] of LEGAL_PHRASES) {
    t = (' ' + t + ' ').split(' ' + phrase + ' ').join(' ' + code + ' ').trim();
  }
  const parts = t.split(' ').filter(Boolean);
  let legal = '';
  if (parts.length > 1 && LEGAL_CODES.has(parts[parts.length - 1])) legal = parts.pop();
  return { core: parts.join(' '), legal };
}

/** Same company: same name without legal form, and the legal form agrees when both sides state one. */
function sameCompany(a, b) {
  return a.core !== '' && a.core === b.core && (!a.legal || !b.legal || a.legal === b.legal);
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One entry per company name listed in each result (a result can list many companies). */
function parseResults(html) {
  const out = [];
  for (const item of html.split('<li class="resultado-busqueda"').slice(1)) {
    const issue = cleanText((item.match(/<p class="linea-dem">([\s\S]*?)<\/p>/) || [])[1]);
    const namesHtml = (item.match(/<p>([\s\S]*?)<\/p>/) || [])[1] || '';
    const ref = (item.match(/doc\.php\?id=([A-Za-z0-9-]+)/) || [])[1] || '';
    const docUrl = ref ? DOC + ref : '';
    for (const line of namesHtml.split(/\r?\n|<br\s*\/?>/i).map(cleanText)) {
      const role = (line.match(/\(([^)]*)\)/) || [])[1] || '';
      const name = line.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
      if (name) out.push({ name, role, borme_issue: issue, reference: ref, doc_url: docUrl });
    }
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const want = nameKey(input);
  // The site's search does not match "S.L." / "SOCIEDAD LIMITADA" reliably, so search the name without the legal
  // form and check the legal form below, when the results are read.
  const url = new URL(SEARCH);
  url.searchParams.set('campo[0]', 'TITULO');
  url.searchParams.set('dato[0]', want.core);
  url.searchParams.set('page_hits', String(PAGE_HITS));
  url.searchParams.set('accion', 'Buscar');
  const source_url = url.href;
  const out = (status, reason, excerpt, records = []) => ({ status, reason, records, source_url, excerpt });

  try {
    if (!want.core) return out('couldnt_check', 'other', 'empty company name');

    let res;
    try {
      res = await fetch(source_url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return out('couldnt_check', timeout ? 'timeout' : 'other', String(err?.message || err).slice(0, 300));
    }
    if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', `HTTP ${res.status}`);
    if (!res.ok) return out('couldnt_check', 'http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|challenge-platform|cf-chl/i.test(html)) return out('couldnt_check', 'blocked', 'bot check page');

    const text = cleanText(html);
    const header = text.match(/Resultados\s+(\d+)\s+a\s+(\d+)\s+de\s+([\d.]+)/);
    const noResults = /No se han encontrado documentos/i.test(text);
    if (!header && !noResults) return out('couldnt_check', 'layout_changed', text.slice(0, 300));

    const total = header ? Number(header[3].replace(/\./g, '')) : 0;
    const shownUpTo = header ? Number(header[2]) : 0;
    const overflow = total > shownUpTo;

    const matches = parseResults(html).filter((r) => sameCompany(want, nameKey(r.name)));

    if (matches.length) {
      const first = matches[0];
      return out('found', '', `BORME section II: ${first.borme_issue}: ${first.name}${first.role ? ' (' + first.role + ')' : ''}`, matches);
    }
    if (overflow) {
      return out('couldnt_check', 'other', `search has ${total} results, only the first ${shownUpTo} were read; the name may be further on`);
    }
    return out('not_found', '', `BORME section II (announcements) search: ${total} results, none with this name. Section I is not searchable by name on this site.`);
  } catch (err) {
    return out('couldnt_check', 'other', String(err?.message || err).slice(0, 300));
  }
}
