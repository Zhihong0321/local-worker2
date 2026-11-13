export const meta = { task: 'PH-onlineblacklistingportal.gppb.gov.ph', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'bo_issued', 'min_date', 'max_date'],
  canary: { found: 'Tri-Green Supply and Technology', not_found: 'Kompanyang Hindi Nakalista Inc.' } };

// The portal's own dashboard calls this JSON list (public, no login). The search_term parameter is ignored by the
// server, so the handler downloads the whole list (500 entities, one request) and matches the name locally.
const LIST_URL = 'https://onlineblacklistingportal.gppb.gov.ph/obp-backend/dashboard/list-blacklisted-entities/?csv=TRUE';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'opc', 'sdn', 'bhd', 'pte', 'plc']);

/** Lower case, accents and punctuation removed, legal form words removed. Keeps letters of any script. */
function normalize(str) {
  return (str || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .filter((w) => !LEGAL_FORMS.has(w))
    .join(' ');
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows, Node 24 aborts (exit 127) if the process exits while the fetch socket is still closing.
  // Give the socket a moment to close before the caller ends the process.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const wanted = normalize(keyword);
    if (!wanted) return fail('other', 'the company name has no letters or numbers');

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://onlineblacklistingportal.gppb.gov.ph/' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    if (/captcha|access denied|sign in to continue/i.test(text.slice(0, 2000))) return fail('blocked', text.slice(0, 300));

    let rows;
    try { rows = JSON.parse(text); } catch { return fail('layout_changed', text.slice(0, 300)); }
    // An empty or differently shaped list is not "not listed": the site did not answer with the list we know.
    if (!Array.isArray(rows) || rows.length === 0 || rows.some((r) => !r || typeof r.blacklisted_entity !== 'string')) {
      return fail('layout_changed', JSON.stringify(rows).slice(0, 300));
    }

    const matches = rows.filter((r) => normalize(r.blacklisted_entity) === wanted);
    const source = LIST_URL;

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: source,
        excerpt: `No match for "${keyword}" in the ${rows.length} entities on the public blacklist list`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((r) => ({
        name: r.blacklisted_entity,
        bo_issued: String(r.bo_issued ?? ''),
        min_date: r.min_date || '',
        max_date: r.max_date || '',
      })),
      source_url: source,
      excerpt: matches.map((r) => `${r.blacklisted_entity}: ${r.bo_issued ?? ''} blacklisting order(s), ${r.min_date || '?'} to ${r.max_date || '?'}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', String(err?.cause?.message || err?.message || err));
  }
}
