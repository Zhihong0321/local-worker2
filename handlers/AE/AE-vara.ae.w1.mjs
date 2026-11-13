export const meta = { task: 'AE-vara.ae', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'trade_name', 'reference', 'licence_type', 'licensed_activities', 'licence_issued', 'status', 'cma_registration_number'],
  canary: { found: 'Komainu MEA FZE', not_found: 'شركة الأصول الرقمية غير المرخصة ذ.م.م' } };

// VARA public register: one server-rendered page that lists every licensed VASP (61 rows when checked on 2026-11-12).
const REGISTER_URL = 'https://www.vara.ae/en/licenses-and-register/public-register/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words dropped before comparing names (so "ACME FZE" and "Acme" compare as "acme").
const LEGAL_FORMS = new Set(['fze', 'fzc', 'fzco', 'fzllc', 'fz', 'llc', 'ltd', 'limited', 'pjsc', 'dmcc', 'llp', 'lp',
  'inc', 'corp', 'corporation', 'sa', 'sarl', 'gmbh', 'plc', 'ag', 'bv', 'pte', 'sdn', 'bhd', 'ltda']);

function decode(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised comparison keys for one name: the main name, and each bracketed trade name. */
function keysOf(name) {
  const keys = new Set();
  const main = name.replace(/\([^)]*\)/g, ' ');
  const inner = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  for (const part of [main, ...inner]) {
    const tokens = part.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
      .split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL_FORMS.has(t));
    const key = tokens.join('');
    if (key) keys.add(key);
  }
  return keys;
}

/** One array of cell texts per register row (rows carry the class tr-registry). */
function parseRows(html) {
  const rows = [];
  const re = /<tr\b[^>]*\btr-registry\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    rows.push([...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => cleanText(c[1])));
  }
  return rows;
}

function couldntCheck(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword ?? '').trim();
    const mine = keysOf(input);
    if (!mine.size) return couldntCheck('other', REGISTER_URL, 'no usable company name was given');

    const res = await fetch(REGISTER_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldntCheck('blocked', REGISTER_URL, `HTTP ${res.status}`);
    if (!res.ok) return couldntCheck('http_error', REGISTER_URL, `HTTP ${res.status}`);

    const html = await res.text();
    if (!/tr-registry/.test(html) && /captcha|cf-chl|access denied/i.test(html)) {
      return couldntCheck('blocked', REGISTER_URL, 'bot check page instead of the register');
    }
    if (!/VASP Name/.test(html) || !/Licence Type/.test(html)) {
      return couldntCheck('layout_changed', REGISTER_URL, html.slice(0, 300));
    }

    const rows = parseRows(html);
    if (!rows.length || rows.some((c) => c.length < 7)) {
      return couldntCheck('layout_changed', REGISTER_URL, `register rows not as expected (${rows.length} rows)`);
    }

    const records = [];
    for (const cells of rows) {
      const rowKeys = keysOf(cells[0]);
      if (![...rowKeys].some((k) => mine.has(k))) continue;
      const trade = [...cells[0].matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).join('; ');
      records.push({
        name: cells[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim(),
        trade_name: trade,
        reference: cells[2],
        licence_type: cells[1],
        licensed_activities: cells[3],
        licence_issued: cells[4],
        status: cells[5],
        cma_registration_number: cells[6],
      });
    }

    if (!records.length) {
      const arabicNote = /\p{Script=Arabic}/u.test(input)
        ? ' The register publishes English names only, so an Arabic-only name cannot be matched here.' : '';
      return {
        status: 'not_found', reason: '', records: [], source_url: REGISTER_URL,
        excerpt: `Register lists ${rows.length} VASPs; no name matches "${input}" after normalising case, punctuation and legal form.${arabicNote}`,
      };
    }

    return {
      status: 'found', reason: '', records, source_url: REGISTER_URL,
      excerpt: records.map((r) => [r.name, r.licence_type, r.reference, r.status].join(' | ')).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldntCheck(timeout ? 'timeout' : 'other', REGISTER_URL, String(err?.message || err).slice(0, 300));
  }
}
