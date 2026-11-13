export const meta = {
  task: 'CH-aoos.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'place', 'asset_manager', 'trustee', 'audit_company'],
  canary: { found: 'Crossinvest Zürich AG', not_found: 'Nichtgelistet Treuhand Probe AG' },
};

// The AOOS "Angeschlossene AO" page (https://www.aoos.ch/de/angeschlossene-ao) fills its table from this JSON API.
const API = 'https://portal.aoos.ch/api/Website/GetCustomerInformation';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NO_RESULTS = 'Your query has no results.';

// Legal forms, compared without punctuation (e.g. "S.A." -> "sa", "S.à r.l." -> "s a r l" -> words "S.à" + "r.l.").
const LEGAL = new Set(['ag', 'sa', 'sagl', 'sarl', 'rl', 'srl', 'spa', 'gmbh', 'ltd', 'limited', 'inc', 'llc', 'llp',
  'plc', 'se', 'kg', 'co', 'corp', 'nv', 'bv', 'ab', 'sas', 'sl']);

/** Lower case, no accents, no punctuation: "Dr. Blumer & Partner" -> ["dr", "blumer", "and", "partner"]. */
function tokens(s) {
  return String(s || '')
    .replace(/ß/g, 'ss').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/œ/gi, 'oe').replace(/ł/gi, 'l').replace(/đ/gi, 'd')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean);
}

function words(s) {
  return String(s || '').replace(/[,|()*@=]/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** The name as typed, minus trailing legal-form words (original spelling kept, for searching). */
function coreWords(s) {
  const w = words(s);
  while (w.length > 1 && LEGAL.has(tokens(w[w.length - 1]).join(''))) w.pop();
  return w;
}

/** Comparison key: normalised name without legal form. Two names match when their keys are equal. */
function key(s) {
  return coreWords(s).flatMap(tokens).join(' ');
}

/** Longest word (3+ letters, accents kept) - a second search term when the full name finds nothing. */
function longestWord(s) {
  const cands = coreWords(s).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length >= 3);
  if (!cands.length) return '';
  return cands.reduce((a, b) => (b.length > a.length ? b : a));
}

/** One search request. Returns { items, url } or { empty, url } or { fail, reason, url, excerpt }. Never throws. */
async function query(term) {
  const url = `${API}?sorts=Name&Filters=Name@=*${encodeURIComponent(term)}&language=de`;
  const fail = (reason, excerpt) => ({ fail: true, reason, url, excerpt: String(excerpt).slice(0, 300) });
  let res;
  let text;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', e && e.message ? e.message : e);
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
  if (res.status === 400) {
    // The site's own answer for "nothing matches" is HTTP 400 with this message. Anything else is an error.
    let msg = '';
    try { msg = JSON.parse(text).Message || ''; } catch { /* not JSON */ }
    if (msg === NO_RESULTS) return { empty: true, url };
    return fail('http_error', `HTTP 400 ${text}`);
  }
  if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (/captcha|challenge|access denied|cloudflare/i.test(text)) return fail('blocked', text);
    return fail('layout_changed', text);
  }
  if (!Array.isArray(data)) return fail('layout_changed', text);
  return { items: data, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    if (!input || !key(input)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty company name' };
    }
    // One search request. The site matches substrings, so the longest word of the name finds every entry that
    // contains the full name; the normalised comparison below then picks the exact company.
    const term = longestWord(input) || coreWords(input).join(' ');
    const r = await query(term);
    // A refused or broken search is never "not found": stop with couldnt_check.
    if (r.fail) return { status: 'couldnt_check', reason: r.reason, records: [], source_url: r.url, excerpt: r.excerpt };

    const want = key(input);
    const matches = (r.items || []).filter((it) => key(it.Name) === want);
    if (matches.length) {
      const records = matches.map((m) => ({
        name: m.Name,
        place: m.Place,
        asset_manager: !!m.IsVV,
        trustee: !!m.IsTrustee,
        audit_company: m.AuditCompany || '',
      }));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: r.url,
        excerpt: records.map((x) => `${x.name}, ${x.place}`).join('; ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: r.url,
      excerpt: `AOOS list: no entry matches "${input}" (searched: ${term})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: API,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
