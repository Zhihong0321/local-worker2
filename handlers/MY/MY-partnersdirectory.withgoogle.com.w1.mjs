export const meta = {
  task: 'MY-partnersdirectory.withgoogle.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'website', 'country', 'city', 'profile_url', 'agency_id'],
  canary: { found: 'Kingdom Digital', not_found: 'Dezeno' },
};

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const url = `https://partnersdirectory.withgoogle.com/api/v1/partners/search/?search_term=${encodeURIComponent(keyword)}&limit=10&offset=0`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const json = await res.json();
    if (!json || typeof json !== 'object' || !Array.isArray(json.data)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: JSON.stringify(json).slice(0, 200) };
    }

    const kwNorm = normalize(keyword);
    const matched = json.data.filter(item => {
      const nameNorm = normalize(item.company_name);
      const webNorm = normalize(item.company_website_url);
      return nameNorm.includes(kwNorm) || kwNorm.includes(nameNorm) || webNorm.includes(kwNorm);
    });

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `Found 0 matching partners for ${keyword} (total raw results: ${json.data.length})`
      };
    }

    const records = matched.map(m => ({
      name: m.company_name,
      website: m.company_website_url,
      country: m.company_address__country_name_code,
      city: m.company_address__locality_name,
      profile_url: m.company_profile_url,
      agency_id: m.company_profile_agency_id
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matched[0].company_profile_url || url,
      excerpt: JSON.stringify(matched[0]).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://partnersdirectory.withgoogle.com/',
      excerpt: String(err?.message || err)
    };
  }
}