export const meta = {
  task: 'ES-camara.es',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'municipality', 'street', 'postal_town', 'activity', 'detail_url'],
  canary: { found: 'TELEFONICA BROADCAST SERVICES S.L.U.', not_found: 'EMPRESA INEXISTENTE QXZWV SL' },
};

// Censo Nacional de Empresas (censo.camara.es): a POST form (listado.php) that lists up to 50 companies
// whose name contains the typed text, then one detail page (ficha.php) per company.
// The site reads and writes ISO-8859-1, so the search text is percent-encoded as Latin-1 bytes.

const BASE = 'https://censo.camara.es/';
const LIST = 'https://censo.camara.es/listado.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIMIT = 50;        // the site shows at most 50 matches
const DETAIL_MAX = 5;    // detail pages fetched per lookup (the rest keep the list fields only)

const ENT = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', aacute: 'á', eacute: 'é', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó',
  Uacute: 'Ú', ordf: 'ª', ordm: 'º' };

// Legal form at the end of the typed name, in its written forms (S.L.U., SL, S.A., SOCIEDAD LIMITADA ...).
const LEGAL_RAW = /(?:^|\s|,)(?:SOCIEDAD\s+(?:ANONIMA|LIMITADA|COOPERATIVA)(?:\s+(?:UNIPERSONAL|LABORAL))?|S\.?\s?C\.?\s?O\.?\s?O\.?\s?P\.?|S\.?\s?C\.?\s?R\.?\s?L\.?|S\.?\s?[LAC]\.?\s?[LUA]?\.?|S\.?\s?L\.?\s?P\.?|SCOOP|SCP)\.?\s*$/i;
// Same, on a folded name (no punctuation, single spaces).
const LEGAL_FOLDED = /\s(SOCIEDAD ANONIMA UNIPERSONAL|SOCIEDAD LIMITADA UNIPERSONAL|SOCIEDAD LIMITADA|SOCIEDAD ANONIMA|SOCIEDAD COOPERATIVA|S ?C ?O ?O ?P|SCOOP|SCP|SCRL|S ?R ?L|S ?L ?U|S ?A ?U|S ?L ?L|S ?L ?P|S ?A ?L|S ?L|S ?A|S ?C)$/;

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([A-Za-z]+);/g, (m, n) => (ENT[n] !== undefined ? ENT[n] : m))
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Uppercase, accents removed, punctuation dropped, other symbols to single spaces.
// nChar is what a Ñ becomes: the site shows a Ñ as a space in some records, so both readings are tried.
function fold(s, nChar) {
  const t = String(s || '').replace(/[Ññ]/g, nChar).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return t.replace(/[.,'"`´’]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}

function splitLegal(folded) {
  const m = folded.match(LEGAL_FOLDED);
  if (!m) return { base: folded, legal: '' };
  return { base: folded.slice(0, m.index).trim(), legal: m[1].replace(/ /g, '') };
}

/** True when the listed name is the typed company: same folded name, or same base name with the same legal form. */
function sameCompany(typed, listed) {
  const kVariants = [...new Set([fold(typed, ' '), fold(typed, 'N')])];
  const rVariants = [...new Set([fold(listed, ' '), fold(listed, 'N')])];
  for (const k of kVariants) {
    for (const r of rVariants) {
      if (k && k === r) return true;
      const ks = splitLegal(k);
      const rs = splitLegal(r);
      if (ks.base && ks.base === rs.base && (!ks.legal || !rs.legal || ks.legal === rs.legal)) return true;
    }
  }
  return false;
}

// Latin-1 percent-encoding of a form value (ASCII letters and digits as they are, space as +).
function latin1Encode(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || '.-_~'.includes(ch)) out += ch;
    else if (c === 32) out += '+';
    else if (c < 256) out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    else out += '%3F';
  }
  return out;
}

function formBody(term) {
  return `empresa=${latin1Encode(term)}&direccion=&cpostal=&municipios=&epigrafes=&seccion=censo`;
}

function decodeSite(buf) {
  return new TextDecoder('iso-8859-1').decode(buf);
}

function parseRows(html) {
  const rows = [];
  const re = /<tr[^>]*>\s*<td[^>]*>\s*<a href="(ficha\.php\?[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) {
    rows.push({ href: m[1], name: cleanText(m[2]), municipality: cleanText(m[3]) });
  }
  return rows;
}

/** One search request. Returns { fail, excerpt } or { count, overflow, rows }. */
async function search(term, signal) {
  const res = await fetch(LIST, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': BASE,
      'Connection': 'close',
    },
    body: formBody(term),
    signal,
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  const html = decodeSite(await res.arrayBuffer());
  if (/captcha/i.test(html)) return { fail: 'blocked', excerpt: 'captcha on the search page' };
  const cm = html.match(/Se han encontrado\s+(?:m(?:&aacute;|á)s de\s+)?(\d+)\s+empresas/i);
  if (!cm) return { fail: 'layout_changed', excerpt: cleanText(html).slice(0, 300) };
  const overflow = /Se han encontrado\s+m(?:&aacute;|á)s de/i.test(html);
  const count = Number(cm[1]);
  const rows = parseRows(html);
  if (rows.length !== (overflow ? LIMIT : count)) {
    return { fail: 'layout_changed', excerpt: `search page says ${count} companies, ${rows.length} rows parsed` };
  }
  return { count, overflow, rows };
}

/** Street, postal code and town, activity from one detail page. */
async function fetchDetail(url, signal) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Connection': 'close' },
    signal,
  });
  if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
  const html = decodeSite(await res.arrayBuffer());
  // Text cells: company name, street, "28050 MADRID - MADRID", "769 - OTROS SERVICIOS ..." (activity codes).
  // Each is picked by its shape, not by position, so an odd record cannot shift the others.
  const cells = [...html.matchAll(/<td[^>]*class="txt11gris"[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => cleanText(m[1]))
    .filter(Boolean);
  const isPostal = (c) => /^\d{5}\s/.test(c);
  const isActivity = (c) => /^\d{3,4}\s*-\s/.test(c);
  const street = cells.slice(1).find((c) => !isPostal(c) && !isActivity(c)) || '';
  return {
    street,
    postal_town: cells.find(isPostal) || '',
    activity: cells.filter(isActivity).join(' | '),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').replace(/\s+/g, ' ').trim();
  const remaining = () => 55000 - (Date.now() - started);
  const sig = () => AbortSignal.timeout(Math.max(1000, Math.min(25000, remaining())));
  const sourceFor = (term) => `${LIST}?${formBody(term)}`;
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    // Search with the legal form dropped first (broadest), then with the name as typed if there are too many hits.
    const base = kw.replace(LEGAL_RAW, '').trim();
    const terms = base && base !== kw ? [base, kw] : [kw];
    let picked = null;
    for (const term of terms) {
      const r = await search(term, sig());
      if (r.fail) {
        return { status: 'couldnt_check', reason: r.fail, records: [], source_url: sourceFor(term), excerpt: r.excerpt };
      }
      picked = { ...r, term };
      if (!r.overflow) break;
    }
    const sourceUrl = sourceFor(picked.term);

    const matches = picked.rows.filter((r) => sameCompany(kw, r.name));
    if (matches.length === 0 && picked.overflow) {
      // More than 50 hits and the name is not among the 50 shown: cannot tell it is absent.
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: sourceUrl,
        excerpt: `the site shows only the first ${LIMIT} of more than ${LIMIT} matches for "${picked.term}"; the company is not among them`,
      };
    }
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: picked.count === 0
          ? `Se han encontrado 0 empresas for "${picked.term}"`
          : `the site listed ${picked.count} companies for "${picked.term}", none with this name`,
      };
    }

    const records = matches.map((m) => ({
      name: m.name,
      municipality: m.municipality,
      street: '',
      postal_town: '',
      activity: '',
      detail_url: new URL(m.href, BASE).href,
    }));

    if (remaining() > 35000) {
      const details = await Promise.allSettled(
        records.slice(0, DETAIL_MAX).map((r) => fetchDetail(r.detail_url, sig())),
      );
      details.forEach((d, i) => {
        if (d.status === 'fulfilled') Object.assign(records[i], d.value);
      });
    }

    const first = records[0];
    const excerpt = [first.name, first.street, first.postal_town, first.activity || first.municipality]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);

    return { status: 'found', reason: '', records, source_url: sourceUrl, excerpt };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: sourceFor(kw),
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
