export const meta = {
  task: 'MY-xero.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'partner_tier', 'locations', 'website', 'excerpt'],
  canary: { found: 'CALTRiX', not_found: 'Dezeno' },
};

function matches(r, keyword) {
  const title = (r.title || r.Title || '').toLowerCase();
  const raw = r.raw || {};
  const website = (raw.sfwebsite_url__c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const kw = keyword.toLowerCase().trim();
  const cleanKw = kw.replace(/[^a-z0-9]/g, '');
  const words = kw.split(/\s+/).filter(w => !['sdn', 'bhd', 'pty', 'ltd', 'plt', 'co', 'advisors', 'advisor'].includes(w));

  if (title.includes(kw)) return true;
  if (cleanKw && website.includes(cleanKw)) return true;
  if (words.length > 0 && words.every(w => title.includes(w) || website.includes(w))) return true;
  return false;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  let token = 'xx3ca09408-dde7-4bdc-936e-6e7e722c4025';
  let orgId = 'xeroprod';
  const pageUrl = 'https://www.xero.com/my/advisors/find-advisors/';

  try {
    const pageRes = await fetch(pageUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000)
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const match = html.match(/"publicAccessToken"\s*:\s*"([^"]+)"/);
      if (match) token = match[1];
      const orgMatch = html.match(/"organizationId"\s*:\s*"([^"]+)"/);
      if (orgMatch) orgId = orgMatch[1];
    }
  } catch (e) {
    // Fall back to known default token
  }

  const apiUrl = `https://platform.cloud.coveo.com/rest/search/v2?organizationId=${orgId}`;
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': UA
      },
      body: JSON.stringify({
        q: keyword,
        pipeline: 'Advisor Directory'
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: apiUrl,
        excerpt: `HTTP status ${res.status}`
      };
    }

    const data = await res.json();
    const results = data.results || [];
    const records = [];
    let bestExcerpt = '';

    for (const r of results) {
      if (matches(r, keyword)) {
        const title = r.title || r.Title || '';
        const raw = r.raw || {};
        const desc = raw.sfdescription__c || r.excerpt || r.Excerpt || '';
        const tier = raw.sfpartner_tier__c || '';
        const locs = Array.isArray(raw.adextendedlocations) ? raw.adextendedlocations.join(', ') : (raw.adextendedlocations || '');
        const website = raw.sfwebsite_url__c || '';

        if (!bestExcerpt) bestExcerpt = `${title} (${tier || 'Advisor'}): ${desc}`.slice(0, 500);
        records.push({
          name: title,
          partner_tier: tier,
          locations: locs,
          website: website,
          excerpt: desc.slice(0, 300)
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.xero.com/my/advisors/find-advisors/',
        excerpt: `No Xero certified advisor records found matching "${keyword}".`
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: 'https://www.xero.com/my/advisors/find-advisors/',
      excerpt: bestExcerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: apiUrl,
      excerpt: String(err)
    };
  }
}
