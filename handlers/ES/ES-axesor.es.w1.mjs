export const meta = {
  task: 'ES-axesor.es',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'cif', 'legal_form', 'founded', 'address', 'province', 'status', 'match', 'detail_url'],
  canary: { found: 'TELEFONICA MOVILES ESPAÑA SA', not_found: 'Distribuciones Inexistentes Lunares Ficticias SL' },
};

const BASE = 'https://www.axesor.es';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' };
const RESULT_CAP = 100;
const MAX_DETAILS = 3;

const LEGAL_TAIL = new Set(['SA', 'SL', 'SLU', 'SAU', 'SLL', 'SAL', 'SLP', 'SRL', 'SCA', 'SCOOP', 'SC', 'SCP', 'SLNE', 'AIE', 'UTE']);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Comparable key: case, accents, punctuation, spacing and Spanish legal form removed. '' when nothing is left. */
function nameKey(s) {
  let t = fold(s).toUpperCase().replace(/[.,;:'"`´’()\[\]\/\\&+*_\-]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\bS A U\b/g, 'SAU').replace(/\bS L U\b/g, 'SLU').replace(/\bS A\b/g, 'SA').replace(/\bS L\b/g, 'SL');
  t = t.replace(/\b(SOCIEDAD|SOCIETAT) ANONIMA UNIPERSONAL\b/g, 'SAU')
       .replace(/\b(SOCIEDAD|SOCIETAT) LIMITADA UNIPERSONAL\b/g, 'SLU')
       .replace(/\bSOCIEDAD ANONIMA LABORAL\b/g, 'SAL')
       .replace(/\bSOCIEDAD LIMITADA LABORAL\b/g, 'SLL')
       .replace(/\b(SOCIEDAD|SOCIETAT) ANONIMA\b/g, 'SA')
       .replace(/\b(SOCIEDAD|SOCIETAT) LIMITADA\b/g, 'SL')
       .replace(/\bSOCIEDAD COMANDITA POR ACCIONES\b/g, 'SCA');
  const tokens = t.split(' ').filter(Boolean);
  while (tokens.length && LEGAL_TAIL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&ntilde;/g, 'ñ').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function text(html) {
  return decode(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Named rows of the search results table, or null when the table is not on the page.
 * Linked rows carry the legal name in their URL slug; the shown name is often a brand or acronym, so it is not matched.
 * Rows without a profile link keep the name they show.
 */
function parseRows(html) {
  const table = html.match(/<table[^>]*id="tablaEmpresas"[\s\S]*?<\/table>/i);
  if (!table) return null;
  const rows = [];
  for (const tr of table[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const tds = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(text);
    if (tds.length < 2) continue;
    const shown = text((tr.match(/<span class="ordenacion[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || tds[0];
    if (!shown) continue;
    const province = tds[1] || '';
    const status = tds[2] || '';
    const link = tr.match(/href="([^"]*\/Informes-Empresas\/\d+\/[^"?#]+?\.html)"/i);
    if (!link) {
      rows.push({ href: '', names: [{ n: shown, how: 'listed name' }], shown, province, status });
      continue;
    }
    let slug = link[1].split('/').pop().replace(/\.html$/i, '');
    try { slug = decodeURIComponent(slug); } catch (e) { /* keep raw slug */ }
    const names = [{ n: slug.replace(/_/g, ' '), how: 'legal name' }];
    const addl = text((tr.match(/<span class="informacion-adicional"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    const former = addl.match(/^Denominación social (?:histórica|anterior) de\s+(.+)$/i);
    if (former) names.push({ n: former[1].trim(), how: 'former name' });
    rows.push({ href: new URL(decode(link[1]), BASE).href, names, shown, province, status });
  }
  return rows;
}

function parseDetail(html) {
  const t = text(html);
  const i = t.indexOf('Datos básicos');
  if (i < 0) return null;
  const seg = t.slice(i, i + 1500);
  const pick = (re) => ((seg.match(re) || [])[1] || '').trim();
  return {
    name: pick(/Nombre\s+(.{1,200}?)\s+CIF\s/),
    cif: pick(/CIF\s+([A-Z0-9]{7,12})\b/),
    legal_form: pick(/Forma jurídica\s+(.{1,120}?)\s+Fecha de constitución/),
    founded: pick(/Fecha de constitución\s+(\d{2}\/\d{2}\/\d{4})/),
    address: pick(/Dirección\s+(.{1,200}?)\s+Ver dirección/),
    excerpt: seg.slice(0, 300),
  };
}

async function getText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  return { res, html: res.ok ? await res.text() : '' };
}

function failure(err, url) {
  const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(err && err.message || err).slice(0, 300) };
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The wrapper waits 500 ms before answering: on Node 24 / Windows a runner that calls process.exit()
 * right after a fetch with an open keep-alive socket aborts with a libuv assertion (exit 127). The pause lets the socket settle.
 */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const searchUrl = `${BASE}/buscar/empresas?q=${encodeURIComponent(String(keyword || '').trim())}`;
  try {
    const key = nameKey(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'the keyword has no company name left after removing the legal form' };
    }

    const { res, html } = await getText(searchUrl);
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const rows = parseRows(html);
    if (rows === null) {
      if (/captcha|access denied|acceso denegado/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: text(html).slice(0, 200) };
      }
      if (/0 resultados|no se (han )?encontrad/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: '0 results' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text(html).slice(0, 300) };
    }

    const totalM = html.match(/id="TodasProvinciaSoc"[\s\S]*?resultados_encontrados">\s*(\d+)/i);
    const total = totalM ? Number(totalM[1]) : null;
    const truncated = total !== null ? total > rows.length : rows.length >= RESULT_CAP;

    const matches = [];
    for (const row of rows) {
      const hit = row.names.find((c) => nameKey(c.n) === key);
      if (hit) matches.push({ row, how: hit.how });
    }

    if (matches.length === 0) {
      if (truncated) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `the site lists ${total ?? rows.length} results but shows only ${rows.length}; the exact name may be among the rest` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${rows.length} results listed, none with the name ${String(keyword).trim()}` };
    }

    const read = await Promise.all(matches.map(async ({ row, how }, idx) => {
      const base = { name: row.shown, province: row.province, status: row.status, match: how, detail_url: row.href || null };
      if (!row.href || idx >= MAX_DETAILS) return { record: base, excerpt: '' };
      try {
        const d = await getText(row.href);
        const det = d.res.ok ? parseDetail(d.html) : null;
        if (!det) return { record: base, excerpt: '' };
        const record = { ...base, name: det.name || base.name, cif: det.cif, legal_form: det.legal_form, founded: det.founded, address: det.address };
        return { record, excerpt: det.excerpt };
      } catch (e) {
        return { record: base, excerpt: '' };
      }
    }));

    const records = read.map((r) => r.record);
    const shown = matches.length > MAX_DETAILS ? ` (${matches.length} matches; details read for the first ${MAX_DETAILS})` : '';
    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].row.href,
      excerpt: (read[0].excerpt || `${records.length} matching record(s)`) + shown,
    };
  } catch (err) {
    return failure(err, searchUrl);
  }
}
