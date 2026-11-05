export const meta = {
  task: 'MY-ransomlook.io',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['group_name', 'post_title', 'discovered', 'description', 'link', 'misp_uuid'],
  canary: {
    found: 'Astino Berhad',
    not_found: 'O2O Digital',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = keyword.trim();
    if (cleanKeyword.length < 2) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.ransomlook.io/api/search',
        excerpt: 'Search keyword too short (minimum 2 characters)',
      };
    }

    const apiUrl = `https://www.ransomlook.io/api/search?q=${encodeURIComponent(cleanKeyword)}`;
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
    if (!data || typeof data !== 'object') {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: 'Response JSON missing expected search result structure',
      };
    }

    const allMatches = [];

    if (Array.isArray(data.posts)) {
      for (const p of data.posts) {
        allMatches.push({
          group_name: p.group_name || '',
          post_title: p.post_title || '',
          discovered: p.discovered || '',
          description: p.description || '',
          link: p.link || '',
          misp_uuid: p.misp_uuid || '',
        });
      }
    }

    if (Array.isArray(data.leaks)) {
      for (const l of data.leaks) {
        allMatches.push({
          group_name: l.group_name || 'leak',
          post_title: l.title || l.leak_title || '',
          discovered: l.date || l.discovered || '',
          description: l.description || '',
          link: l.link || '',
          misp_uuid: l.uuid || '',
        });
      }
    }

    if (Array.isArray(data.notes)) {
      for (const n of data.notes) {
        allMatches.push({
          group_name: n.group_name || 'note',
          post_title: n.title || '',
          discovered: n.discovered || '',
          description: n.note || '',
          link: '',
          misp_uuid: '',
        });
      }
    }

    if (allMatches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: apiUrl,
        excerpt: 'Zero extortion posts, leaks, or ransom notes match query.',
      };
    }

    return {
      status: 'found',
      reason: '',
      records: allMatches,
      source_url: apiUrl,
      excerpt: `Found ${allMatches.length} ransomware record(s): ${allMatches[0].post_title} by group ${allMatches[0].group_name} (${allMatches[0].discovered})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.ransomlook.io/api/search',
      excerpt: err.message || String(err),
    };
  }
}
