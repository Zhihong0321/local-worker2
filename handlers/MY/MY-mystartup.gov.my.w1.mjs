export const meta = {
  task: 'MY-mystartup.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'registration_no', 'new_registration_no', 'status', 'company_type', 'state', 'city', 'address', 'founded_date', 'website', 'industries', 'slug'],
  canary: { found: '100BUCKS SDN. BHD.', not_found: 'Syarikat Tiada Rekod Sdn Bhd' },
};

const API = 'https://api.mystartup.gov.my/api/v1/Companies/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;
const BUDGET_MS = 40000;
// Legal-form words that are dropped before comparing names (Malaysian and common foreign forms).
const LEGAL_FORM = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'terhad', 'llp', 'plt', 'llc', 'ltd', 'limited', 'pte', 'inc', 'sdnbhd']);

/** Core name: case, punctuation, the "(M)" marker and legal form removed. Keeps letters of any script. */
function coreTokens(str) {
  const s = String(str || '').normalize('NFKC').toLowerCase().replace(/\(\s*m\s*\)/g, ' ').replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return s.split(/\s+/).filter((t) => t && !LEGAL_FORM.has(t));
}

function coreKey(str) {
  return coreTokens(str).join('');
}

function blockedOrError(status, url) {
  if (status === 403 || status === 429) return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${status}` };
  return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${status}` };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source_url = API;
  try {
    const tokens = coreTokens(keyword);
    if (tokens.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url, excerpt: 'no company name left after removing punctuation and legal form' };
    }
    const term = tokens.join(' ');
    const target = tokens.join('');
    const started = Date.now();
    const matches = [];
    let skip = 0;
    let total = Infinity;
    let scanned = 0;

    while (scanned < total) {
      if (Date.now() - started > BUDGET_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url, excerpt: `search for "${term}" has ${total} results; stopped after ${scanned} to stay under 60 s` };
      }
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          // Node's fetch sends "Accept-Language: *" by default, which this API answers with HTTP 500.
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filters: [], search: term, skip, sort: ['companyName'], take: PAGE }),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) return blockedOrError(res.status, source_url);

      const ctype = res.headers.get('content-type') || '';
      const text = await res.text();
      if (!ctype.includes('json')) {
        const bot = /captcha|challenge|access denied|cloudflare/i.test(text);
        return { status: 'couldnt_check', reason: bot ? 'blocked' : 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
      }
      const result = body && body.result;
      if (!result || !Array.isArray(result.data) || typeof result.totalCount !== 'number') {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url, excerpt: text.slice(0, 300) };
      }

      total = result.totalCount;
      const items = result.data;
      scanned += items.length;
      skip += items.length;

      for (const c of items) {
        const names = [c.companyName, c.legalName].map(coreKey);
        if (names.includes(target)) {
          const hq = c.headquarterLocation || {};
          matches.push({
            name: c.companyName || '',
            legal_name: c.legalName || '',
            registration_no: c.companyRegNo || '',
            new_registration_no: c.companyNewRegNo || '',
            status: c.status || '',
            company_type: Array.isArray(c.companyType) ? c.companyType.join(', ') : '',
            state: hq.state || '',
            city: hq.city || '',
            address: hq.address || '',
            founded_date: c.foundedDate ? String(c.foundedDate).slice(0, 10) : '',
            website: c.websiteUrl || '',
            industries: Array.isArray(c.industries) ? c.industries.join(', ') : '',
            slug: c.slug || '',
          });
        }
      }
      if (items.length === 0) break;
    }

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url, excerpt: `0 companies with the name "${keyword}" among ${total} search results for "${term}"` };
    }
    const first = matches[0];
    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url,
      excerpt: `${matches.length} match(es) for "${keyword}": ${first.legal_name} (${first.registration_no}), status ${first.status}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
