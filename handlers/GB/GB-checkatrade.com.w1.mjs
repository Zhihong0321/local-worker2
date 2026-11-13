export const meta = {
  task: 'GB-checkatrade.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'company_id', 'unique_name', 'location', 'skills', 'profile_url'],
  canary: { found: 'Sash Windows And Doors', not_found: 'Zxqvbnm Plumbing Ltd' },
};

// Checkatrade's own trade search (the one the site's search box calls): a JSON GET with ?name=.
// The API returns fuzzy matches, so the handler compares normalised names itself.
const API = 'https://api.checkatrade.com/v1/consumer-public/trades';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 25; // the API refuses size > 25
const MAX_PAGES = 2;  // 2 x 25 s timeouts stay under the 60 s limit

/** Case, punctuation, "&" = "and", and legal-form words removed. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(ltd|limited|plc|llp|llc)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const firstUrl = `${API}?name=${encodeURIComponent(name)}&page=1&size=${PAGE_SIZE}`;
  try {
    if (!name) return fail('couldnt_check', 'other', firstUrl, 'empty company name');
    const want = normalize(name);
    if (!want) return fail('couldnt_check', 'other', firstUrl, 'company name has no letters or digits');

    const matches = [];
    let scanned = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${API}?name=${encodeURIComponent(name)}&page=${page}&size=${PAGE_SIZE}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return fail('couldnt_check', 'http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return fail('couldnt_check', 'layout_changed', url, text.slice(0, 300));
      }
      if (!json || !Array.isArray(json.data)) return fail('couldnt_check', 'layout_changed', url, text.slice(0, 300));

      scanned += json.data.length;
      for (const item of json.data) {
        if (item && normalize(item.name) === want) {
          matches.push({
            name: item.name,
            company_id: item.companyId ?? null,
            unique_name: item.uniqueName || '',
            location: item.location || '',
            skills: Array.isArray(item.skills) ? item.skills : [],
            profile_url: item.uniqueName ? `https://www.checkatrade.com/trades/${encodeURIComponent(item.uniqueName)}` : '',
          });
        }
      }
      if (matches.length || json.data.length < PAGE_SIZE) break;
    }

    if (matches.length) {
      const m = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `Checkatrade lists "${m.name}" (companyId ${m.company_id}, ${m.location}); profile ${m.profile_url}`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Checkatrade trade search returned ${scanned} result(s) for "${name}", none with the same normalised name`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err).slice(0, 300));
  }
}
