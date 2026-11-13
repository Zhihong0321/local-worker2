export const meta = {
  task: 'CH-sas.admin.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'accreditation_id', 'type_code', 'street_address', 'postal_code', 'locality', 'pdf_url'],
  canary: { found: 'Bioexam AG', not_found: 'Zyxqwv Nichtvorhanden AG' },
};

// The SAS accreditation search is a Vue app embedded in https://www.seco.admin.ch/de/suche-akkreditierte-stellen-sas
// (iframe https://sas.seco.amboss.liip.cloud/?lang=de). That app calls this public JSON API:
//   GET /api/v1/search/?q=<text>&page=1&page_size=<n>  ->  { results: [...], count, page, num_pages }
const API = 'https://sas.seco.amboss.liip.cloud/api/v1/search/';
const ORIGIN = 'https://sas.seco.amboss.liip.cloud';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 500;

// Legal-form words that are ignored when comparing names (after lower-casing, accents removed, dots removed).
const LEGAL = new Set([
  'ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'corp', 'co', 'kg', 'se', 'srl', 'bv', 'nv',
  'aktiengesellschaft', 'genossenschaft', 'stiftung', 'verein',
]);

function fold(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalised name without legal form. Falls back to the full name if nothing else is left. */
function core(str) {
  const tokens = fold(str).split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !LEGAL.has(t));
  return (kept.length ? kept : tokens).join(' ');
}

/** The names a result can be known by: the whole field, and each line of a multi-line field. */
function nameVariants(companyName) {
  const raw = String(companyName || '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [raw.replace(/\s+/g, ' '), ...lines];
}

function excerptOf(s) {
  return String(s || '').slice(0, 300);
}

function absolute(path) {
  if (!path) return '';
  return path.startsWith('http') ? path : ORIGIN + (path.startsWith('/') ? path : '/' + path);
}

async function search(q) {
  const url = `${API}?q=${encodeURIComponent(q)}&page=1&page_size=${PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', url, excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', url, excerpt: `HTTP ${res.status}` };
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { fail: 'layout_changed', url, excerpt: excerptOf(text) };
  }
  if (!data || !Array.isArray(data.results) || typeof data.count !== 'number') {
    return { fail: 'layout_changed', url, excerpt: excerptOf(text) };
  }
  return { data, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty keyword' };

    const wanted = core(kw);
    const queries = [...new Set([core(kw), kw].filter(Boolean))];

    // Search with the name without legal form, and with the name as typed; read both.
    const answers = await Promise.all(queries.map((q) => search(q).catch((e) => ({ fail: 'other', url: API, excerpt: String(e?.message || e) }))));

    const failed = answers.find((a) => a.fail);
    const okAnswers = answers.filter((a) => !a.fail);
    if (okAnswers.length === 0) {
      const f = failed || { fail: 'other', url: API, excerpt: 'no answer' };
      const reason = f.excerpt && /abort|timeout/i.test(f.excerpt) ? 'timeout' : f.fail;
      return { status: 'couldnt_check', reason, records: [], source_url: f.url, excerpt: f.excerpt };
    }

    // A search that returned more rows than it sent back cannot be fully read.
    const truncated = okAnswers.some((a) => a.data.count > a.data.results.length);

    const seen = new Set();
    const matches = [];
    for (const a of okAnswers) {
      for (const r of a.data.results) {
        const key = `${r.accreditation_id}|${r.company_name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = nameVariants(r.company_name).some((v) => core(v) === wanted);
        if (hit) matches.push(r);
      }
    }

    const sourceUrl = okAnswers[0].url;

    if (matches.length > 0) {
      const records = matches.map((r) => {
        const id = String(r.accreditation_id || '');
        const pdf = r.pdf_urls && typeof r.pdf_urls === 'object' ? (r.pdf_urls.de || r.pdf_urls.en || r.pdf_urls.fr || r.pdf_urls.it || '') : '';
        return {
          name: String(r.company_name || '').replace(/\s+/g, ' ').trim(),
          accreditation_id: id,
          type_code: id.split(' ')[0] || '',
          street_address: String(r.street_address || '').trim(),
          postal_code: String(r.postal_code || '').trim(),
          locality: String(r.locality || '').trim(),
          pdf_url: absolute(pdf),
        };
      });
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: `${records.length} accreditation record(s) for "${kw}": ${records.map((r) => r.accreditation_id).join(', ')}`,
      };
    }

    if (truncated) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: sourceUrl,
        excerpt: `search for "${kw}" returned more rows than one page; no exact name match in the rows read`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `0 accreditation records with this name for "${kw}" (search returned ${okAnswers.map((a) => a.data.count).join(' / ')} row(s), none with this name)`,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    const reason = /abort|timeout/i.test(String(err?.name || '') + msg) ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: API, excerpt: msg.slice(0, 300) };
  }
}
