export const meta = {
  task: 'MY-recommend.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'category', 'location', 'slug', 'profile_url'],
  canary: {
    found: 'Sern Interior Design and Renovation',
    not_found: 'O2O Digital',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = keyword.trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.recommend.my/business_categories_profiles_search',
        excerpt: 'Empty search keyword',
      };
    }

    const apiUrl = `https://www.recommend.my/business_categories_profiles_search?name=${encodeURIComponent(cleanKeyword)}`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: apiUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: 'Expected JSON array response from search endpoint',
      };
    }

    const records = [];
    for (const item of data) {
      if (item && item.text) {
        records.push({
          name: item.text,
          category: item.category || '',
          location: item.location || '',
          slug: item.slug || '',
          profile_url: item.slug ? `https://www.recommend.my/businesses/${item.slug}` : '',
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: apiUrl,
        excerpt: 'Zero merchant business profiles matched search query',
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: apiUrl,
      excerpt: `Found ${records.length} profile(s): ${records[0].name} (${records[0].category}, ${records[0].location})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.recommend.my/business_categories_profiles_search',
      excerpt: err.message || String(err),
    };
  }
}
