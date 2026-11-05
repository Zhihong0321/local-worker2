export const meta = {
  task: 'SG-aams.org.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'url', 'address', 'category'],
  canary: {
    found: 'AnyMind Group Pte Ltd',
    not_found: 'OOm Pte Ltd',
  },
};

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = normalize(keyword);
    if (!target) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://aams.org.sg/our-members',
        excerpt: '',
      };
    }

    const catRes = await fetch('https://admin.aams.org.sg/api/getMDirectoryCategory', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!catRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: 'https://admin.aams.org.sg/api/getMDirectoryCategory',
        excerpt: '',
      };
    }

    const catData = await catRes.json();
    if (!catData || !Array.isArray(catData.category_list) || catData.category_list.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://admin.aams.org.sg/api/getMDirectoryCategory',
        excerpt: '',
      };
    }

    // Default to the first category (Agencies/Corporates) or check all categories if needed
    const agenciesCat = catData.category_list.find(c => /agenc/i.test(c.name)) || catData.category_list[0];

    const memRes = await fetch('https://admin.aams.org.sg/api/getMDirectorywithCategory', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ mdid: agenciesCat.id, status: 1 }),
      signal: AbortSignal.timeout(10000),
    });

    if (!memRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: 'https://admin.aams.org.sg/api/getMDirectorywithCategory',
        excerpt: '',
      };
    }

    const memData = await memRes.json();
    if (!memData || !Array.isArray(memData.mdlist)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://admin.aams.org.sg/api/getMDirectorywithCategory',
        excerpt: '',
      };
    }

    const matches = [];
    for (const item of memData.mdlist) {
      const nameNorm = normalize(item.name);
      if (nameNorm && (nameNorm.includes(target) || target.includes(nameNorm))) {
        matches.push({
          name: item.name,
          url: item.url || '',
          address: item.address || '',
          category: agenciesCat.name || 'Agencies/Corporates',
        });
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: 'https://aams.org.sg/our-members',
        excerpt: JSON.stringify(matches[0]).slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: 'https://aams.org.sg/our-members',
      excerpt: '',
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'http_error',
      records: [],
      source_url: 'https://admin.aams.org.sg/api/getMDirectorywithCategory',
      excerpt: '',
    };
  }
}
