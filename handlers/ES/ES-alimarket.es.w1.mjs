export const meta = {
  task: 'ES-alimarket.es',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'location', 'sector', 'cif', 'group', 'cnae', 'address', 'detail_url'],
  canary: { found: 'MERCADONA, S.A.', not_found: 'Zzqxvbnm Inexistente SL' },
};

const BASE = 'https://www.alimarket.es';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' };

// Legal-form words dropped before comparing names (both sides are normalised the same way).
const LEGAL_TOKENS = new Set(['sa', 'sau', 'sl', 'slu', 'slne', 'sc', 'scoop', 'sccl', 'coop', 'cooperativa', 'sociedad', 'anonima', 'limitada', 'unipersonal', 'srl', 'ltd']);

function normalizeName(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // accents: DIVISIÓN -> DIVISION
    .toLowerCase()
    .replace(/[.']/g, '')                                // S.A. -> SA
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_TOKENS.has(t))
    .join('');
}

function cleanText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reads one "<dt>label</dt><dd>value</dd>" pair from the company page. Values the site hides are "private" and read as ''.
function dlValue(html, label) {
  const m = html.match(new RegExp('<dt>\\s*' + label + '\\s*</dt>\\s*<dd([^>]*)>([\\s\\S]*?)</dd>', 'i'));
  if (!m || /class="private"/i.test(m[1])) return '';
  return cleanText(m[2]);
}

function parseDetail(html) {
  return {
    cif: dlValue(html, 'CIF'),
    group: dlValue(html, 'Grupo'),
    sector: dlValue(html, 'Sectores'),
    cnae: dlValue(html, 'CNAE'),
    address: dlValue(html, 'Direcci[oó]n'),
  };
}

function answer(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const searchUrl = `${BASE}/buscador_empresas_resultados/empresa-${encodeURIComponent(keyword)}`;
  try {
    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return answer('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return answer('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
    if (/\/acceso\//.test(res.url)) return answer('couldnt_check', 'blocked', searchUrl, `redirected to login: ${res.url}`);

    const html = await res.text();
    if (/Just a moment|Attention Required|cf-challenge/i.test(html)) return answer('couldnt_check', 'blocked', searchUrl, 'bot check page');

    const noResults = /Sin resultados para la b[uú]squeda de empresas/i.test(html);
    if (noResults) {
      return answer('not_found', '', searchUrl, 'Sin resultados para la búsqueda de empresas');
    }
    const onResultsPage = /Resultados? de b[uú]squeda de empresas/i.test(html);
    const tableHtml = (html.match(/<table class="table-generic[\s\S]*?<\/table>/) || [])[0];
    if (!onResultsPage || !tableHtml) {
      return answer('couldnt_check', 'layout_changed', searchUrl, cleanText(html).slice(0, 300));
    }

    const bodyHtml = (tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    const items = [];
    for (const row of bodyHtml.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
      if (cells.length < 3) continue;
      const link = cells[0].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) continue;
      items.push({
        name: cleanText(link[2]),
        detail_url: new URL(link[1].replace(/&amp;/g, '&'), BASE).href,
        location: cleanText(cells[1]),
        sector: cleanText(cells[2]),
      });
    }
    if (items.length === 0) {
      return answer('couldnt_check', 'layout_changed', searchUrl, 'results table has no rows with links');
    }

    const countMatch = html.match(/<p class="title03">\s*(\d+)\s+resultados?\s*<\/p>/);
    const total = countMatch ? parseInt(countMatch[1], 10) : items.length;

    const want = normalizeName(keyword);
    if (!want) return answer('couldnt_check', 'other', searchUrl, 'the name has no letters or digits to compare');

    const matches = items.filter((it) => normalizeName(it.name) === want);
    const excerptRows = items.map((it) => `${it.name} | ${it.location} | ${it.sector}`).join(' ; ');

    if (matches.length === 0) {
      if (total > items.length) {
        // The site lists more results than this page shows; an exact match could be on a later page.
        return answer('couldnt_check', 'other', searchUrl, `page shows ${items.length} of ${total} results; no exact name match on it`);
      }
      return answer('not_found', '', searchUrl, `${total} result(s), none with this exact name: ${excerptRows}`);
    }

    // Company detail page: public fields only. CIF and contact are shown to subscribers only and stay ''.
    const records = [];
    for (const m of matches) {
      const rec = { name: m.name, location: m.location, sector: m.sector, cif: '', group: '', cnae: '', address: '', detail_url: m.detail_url };
      if (Date.now() - started < 30000) {
        try {
          const dres = await fetch(m.detail_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
          if (dres.ok) Object.assign(rec, parseDetail(await dres.text()));
        } catch {
          // keep the list fields only
        }
      }
      records.push(rec);
    }

    return answer('found', '', searchUrl, matches.map((m) => `${m.name} | ${m.location} | ${m.sector}`).join(' ; '), records);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
