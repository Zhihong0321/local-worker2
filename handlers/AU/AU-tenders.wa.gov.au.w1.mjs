export const meta = { task: 'AU-tenders.wa.gov.au', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'legal_name', 'abn', 'acn', 'active_business', 'active_supplier', 'head_office_address', 'site_id'],
  canary: { found: 'Iconic Property Services Pty Ltd', not_found: 'Dezeno Pty Ltd' } };

const BASE = 'https://www.tenders.wa.gov.au/watenders/rest/business/searchBySupplier';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change the company's identity (Australian and Malaysian forms).
const LEGAL = new Set(['pty', 'ltd', 'limited', 'sdn', 'bhd', 'inc', 'incorporated', 'llc', 'llp', 'co', 'corp', 'corporation', 'plc', 'company']);

function words(str) {
  return (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Name with case, punctuation, spacing and legal form removed, for an exact comparison. */
function coreName(str) {
  return words(str).filter((w) => !LEGAL.has(w)).join('');
}

/** The keyword without its legal form, as a second search string (empty if nothing is left). */
function strippedQuery(keyword) {
  return words(keyword).filter((w) => !LEGAL.has(w)).join(' ');
}

async function search(name, searchUrl) {
  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    // Not JSON: a bot check or login wall, or a changed page.
    if (/captcha|access denied|verify you are human/i.test(text)) return { fail: { reason: 'blocked', excerpt: text.slice(0, 200) } };
    return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 200) } };
  }
  if (!Array.isArray(data)) return { fail: { reason: 'layout_changed', excerpt: text.slice(0, 200) } };
  return { data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const typed = String(keyword || '').trim();
    if (!typed) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty keyword' };

    const target = coreName(typed);
    if (!target) return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'keyword has no usable name' };

    // One search, with the legal form left out: the site matches names that contain the search text,
    // so "X Pty Ltd" is found by "X". Only one request, so the handler finishes cleanly.
    const query = strippedQuery(typed) || typed;
    const url = `${BASE}?name=${encodeURIComponent(query)}&abn=&acn=&type=contract&maxResults=250&type=contract`;
    const r = await search(query, url);
    if (r.fail) return { status: 'couldnt_check', reason: r.fail.reason, records: [], source_url: url, excerpt: r.fail.excerpt };

    const seen = new Map();
    for (const rec of r.data) if (rec && rec.id != null) seen.set(rec.id, rec);

    const matches = [...seen.values()].filter((rec) =>
      coreName(rec.name) === target || coreName(rec.legalName) === target);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((rec) => ({
          name: rec.name || '',
          legal_name: rec.legalName || '',
          abn: rec.formattedAbn || rec.abn || '',
          acn: rec.formattedAcn || rec.acn || '',
          active_business: rec.activeBusiness === true ? 'yes' : 'no',
          active_supplier: rec.activeSupplier === true ? 'yes' : 'no',
          head_office_address: rec.headOfficeAddress || '',
          site_id: String(rec.id),
        })),
        source_url: url,
        excerpt: `Tenders WA lists ${matches.length} matching supplier record(s) for "${typed}"`,
      };
    }

    // The site answered normally and no record has this company's name.
    const names = [...seen.values()].map((rec) => rec.name).filter(Boolean);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: names.length ? `${names.length} similar supplier name(s), none matching "${typed}": ${names.slice(0, 5).join('; ')}`.slice(0, 300) : `0 supplier records for "${typed}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
