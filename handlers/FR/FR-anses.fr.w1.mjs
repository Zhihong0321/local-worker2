export const meta = { task: 'FR-anses.fr', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'country', 'address', 'updated', 'products'],
  canary: { found: 'AGREVO FRANCE S.A.', not_found: 'SOCIETE FICTIVE INEXISTANTE SARL' } };

// ANSES E-Phy (ephy.anses.fr) "Sociétés" directory: one page per company at /firme/<slug>, and letter index pages
// /lexique/firme/<letter>?page=N that list every company name. A missing company answers with a "Page non trouvée" body.
const BASE = 'https://ephy.anses.fr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'sci', 'gmbh', 'bv', 'nv', 'ltd', 'limited', 'llc', 'inc', 'srl',
  'sl', 'slu', 'ag', 'kg', 'sdn', 'bhd', 'pte', 'plc', 'spa', 'ab', 'oy', 'as', 'llp', 'lp', 'co', 's', 'a', 'b', 'v', 'n']);
const ENT = new Map([['eacute', 'é'], ['egrave', 'è'], ['ecirc', 'ê'], ['euml', 'ë'], ['agrave', 'à'], ['acirc', 'â'],
  ['auml', 'ä'], ['aacute', 'á'], ['ccedil', 'ç'], ['ocirc', 'ô'], ['ouml', 'ö'], ['oacute', 'ó'], ['ucirc', 'û'],
  ['ugrave', 'ù'], ['uuml', 'ü'], ['uacute', 'ú'], ['icirc', 'î'], ['iuml', 'ï'], ['iacute', 'í'], ['ntilde', 'ñ'],
  ['rsquo', '\''], ['apos', '\''], ['quot', '"'], ['amp', '&'], ['nbsp', ' '], ['ndash', '–'], ['mdash', '—']]);

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const slugOf = (s) => tokens(s).join('-');
/** Name key with the legal form removed, so "AGREVO FRANCE SAS" and "AGREVO FRANCE S.A." compare equal. */
function keyOf(s) {
  const t = tokens(s);
  return t.filter((x) => !LEGAL.has(x)).join('') || t.join('');
}

function flat(html) {
  let s = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (ENT.has(n) ? ENT.get(n) : m));
  return s.replace(/\s+/g, ' ').trim();
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, body: await res.text() };
}

const isBlocked = (r) => r.status === 403 || r.status === 429 ||
  (/captcha|cf-chl|just a moment|access denied|verify you are human/i.test(r.body) && !/E-Phy/i.test(r.body));
const isMissing = (r) => r.status === 404 || /Page non trouv|404 Oops/i.test(r.body);

/** Parse one company page. Returns null when the page does not have the expected fields. */
function parseCompany(html) {
  const t = flat(html);
  const name = (t.match(/RAISON SOCIALE (.+?) IDENTIT/) || [])[1] || '';
  if (!name) return null;
  return {
    name,
    country: (t.match(/PAYS : (.+?) Informations/) || [])[1] || '',
    address: (t.match(/D.IDENTIFICATION (.*?) PAYS /) || [])[1] || '',
    updated: (t.match(/Mise . jour le (\d{2}\/\d{2}\/\d{4})/) || [])[1] || '',
    products: ((t.match(/Produits d.tenus par la soci.t. (.*?)(?: FAQ et Contact|$)/) || [])[1] || '').slice(0, 3000),
  };
}

const out = (status, reason, records, source_url, excerpt) =>
  ({ status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) });
const found = (rec, url) => out('found', '', [rec], url,
  `${rec.name} | ${rec.country} | ${rec.address} | Mise à jour le ${rec.updated}`);
const failed = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
  ? out('couldnt_check', 'timeout', [], '', 'request timed out')
  : out('couldnt_check', 'other', [], '', String(e && e.message || e).slice(0, 300));

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const slug = slugOf(kw);
  const want = keyOf(kw);
  if (!slug || !want) return out('couldnt_check', 'other', [], '', 'the name has no Latin letters to match on the site');
  const directUrl = `${BASE}/firme/${slug}`;
  let lastUrl = directUrl;
  try {
    // 1. The company's own page, at the slug built from the name.
    const direct = await get(directUrl);
    if (isBlocked(direct)) return out('couldnt_check', 'blocked', [], directUrl, `HTTP ${direct.status}`);
    if (!isMissing(direct)) {
      if (direct.status !== 200) return out('couldnt_check', 'http_error', [], directUrl, `HTTP ${direct.status}`);
      const rec = parseCompany(direct.body);
      if (!rec) return out('couldnt_check', 'layout_changed', [], directUrl, flat(direct.body).slice(0, 300));
      if (keyOf(rec.name) === want) return found(rec, directUrl);
    }

    // 2. Not on its own page (legal form or accents written differently): read the letter index for that initial.
    const letter = want[0];
    if (!/[a-z]/.test(letter)) return out('couldnt_check', 'other', [], directUrl, 'no letter index for names starting with a digit');
    const matches = [];
    let pages = 0;
    for (let p = 1; p <= 60; p++) {
      if (Date.now() - started > 45000) return out('couldnt_check', 'timeout', [], lastUrl, 'letter index scan ran past 45 s');
      lastUrl = `${BASE}/lexique/firme/${letter}${p > 1 ? `?page=${p}` : ''}`;
      const r = await get(lastUrl);
      if (isBlocked(r)) return out('couldnt_check', 'blocked', [], lastUrl, `HTTP ${r.status}`);
      if (r.status !== 200) return out('couldnt_check', 'http_error', [], lastUrl, `HTTP ${r.status}`);
      const links = [...r.body.matchAll(/<a href="\/firme\/([^"]+)"[^>]*>([^<]*)<\/a>/g)];
      if (p === 1 && links.length === 0 && !/firme/i.test(r.body)) {
        return out('couldnt_check', 'layout_changed', [], lastUrl, flat(r.body).slice(0, 300));
      }
      if (links.length === 0) break; // past the last page: the index has been read in full
      pages++;
      for (const [, s, text] of links) {
        if (keyOf(flat(text)) === want && !matches.includes(s)) matches.push(s);
      }
    }

    if (matches.length === 0) {
      return out('not_found', '', [], directUrl,
        `no company page at /firme/${slug} and no name match in ${pages} letter-index pages for "${letter.toUpperCase()}"`);
    }

    // 3. Read the matching company pages (at most 5).
    const records = [];
    let firstUrl = '';
    for (const s of matches.slice(0, 5)) {
      if (Date.now() - started > 50000) break;
      const url = `${BASE}/firme/${s}`;
      firstUrl = firstUrl || url;
      const m = await get(url);
      if (isBlocked(m)) return out('couldnt_check', 'blocked', [], url, `HTTP ${m.status}`);
      if (m.status !== 200) return out('couldnt_check', 'http_error', [], url, `HTTP ${m.status}`);
      const rec = parseCompany(m.body);
      if (!rec) return out('couldnt_check', 'layout_changed', [], url, flat(m.body).slice(0, 300));
      records.push(rec);
    }
    if (records.length === 0) return out('couldnt_check', 'timeout', [], firstUrl, 'matching pages were not read in time');
    return out('found', '', records, firstUrl, records.map((r) => `${r.name} | ${r.country} | ${r.address}`).join(' ;; '));
  } catch (e) {
    return failed(e);
  }
}
