export const meta = {
  task: 'US-consumerfinance.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'complaints_total', 'sample_complaint_id', 'sample_product', 'sample_state', 'sample_date_received'],
  canary: { found: 'BANK OF AMERICA, NATIONAL ASSOCIATION', not_found: 'ZZQXJ NOT A REAL COMPANY LTD' },
};

const API = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words dropped when comparing names (both sides), so "ACME, INC." matches "Acme Inc".
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'na', 'national', 'association', 'plc', 'lp', 'llp', 'pllc', 'pc']);

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w && !LEGAL.has(w)).join('');
}

// The site's company filter is an exact, case-sensitive match on the names as the site writes them (upper case,
// punctuation included), so try the typed name in upper case, then once more without . and , if that differs.
function candidates(keyword) {
  const upper = keyword.trim().replace(/\s+/g, ' ').toUpperCase();
  const noPunct = upper.replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  return [...new Set([upper, noPunct])].filter(Boolean);
}

function failure(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let lastUrl = API;
  try {
    const cands = candidates(String(keyword || ''));
    if (cands.length === 0) return failure('other', API, 'empty company name');

    for (const cand of cands) {
      const url = `${API}?size=1&company=${encodeURIComponent(cand)}`;
      lastUrl = url;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return failure('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return failure('http_error', url, `HTTP ${res.status}`);

      let data;
      try {
        data = JSON.parse(await res.text());
      } catch {
        return failure('layout_changed', url, 'response is not JSON');
      }
      if (data.timed_out) return failure('timeout', url, 'the site search timed out');
      if (!data.hits || !data.hits.total || typeof data.hits.total.value !== 'number') {
        return failure('layout_changed', url, 'no hits.total in response');
      }

      const total = data.hits.total.value;
      if (total === 0) continue;

      const src = (data.hits.hits && data.hits.hits[0] && data.hits.hits[0]._source) || {};
      if (normalize(src.company) !== normalize(keyword)) continue; // same words, different company

      return {
        status: 'found',
        reason: '',
        records: [{
          name: src.company,
          complaints_total: total,
          sample_complaint_id: src.complaint_id || '',
          sample_product: src.product || '',
          sample_state: src.state || '',
          sample_date_received: src.date_received || '',
        }],
        source_url: url,
        excerpt: `${total} complaints listed under "${src.company}"`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `0 complaints listed for "${keyword}" (searched as: ${cands.join(' | ')})`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(timedOut ? 'timeout' : 'other', lastUrl, String(err?.message || err));
  }
}
