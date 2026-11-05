export const meta = {
  task: 'AU-iabaustralia.com.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'membership_tier'],
  canary: { found: 'In Marketing We Trust', not_found: 'Digital Next' },
};

export default async function lookup(keyword) {
  const url = 'https://www.iabaustralia.com.au/members-and-councils/iab-members/';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: url,
        excerpt: `HTTP status ${res.status}`
      };
    }

    const html = await res.text();

    if (!html.includes('iab-member__name') && !html.includes('/iab-members/')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Expected iab-member class or URL marker missing'
      };
    }

    const memberRegex = /<h3[^>]*class="iab-member__name"[^>]*>([\s\S]*?)<\/h3>/gi;
    const members = [];
    let match;
    while ((match = memberRegex.exec(html)) !== null) {
      const name = match[1]
        .replace(/&#038;/g, '&')
        .replace(/&amp;/g, '&')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (name) members.push(name);
    }

    if (members.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'No members extracted from member directory page'
      };
    }

    const cleanKw = keyword.toLowerCase().trim();
    const matched = members.filter(m => {
      const lower = m.toLowerCase();
      return lower.includes(cleanKw) || cleanKw.includes(lower);
    });

    if (matched.length > 0) {
      const idx = html.toLowerCase().indexOf(matched[0].toLowerCase());
      const excerpt = idx >= 0
        ? html.slice(Math.max(0, idx - 100), Math.min(html.length, idx + 200)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : matched.join(', ');
      return {
        status: 'found',
        reason: '',
        records: matched.map(name => ({ name })),
        source_url: url,
        excerpt: excerpt.slice(0, 500)
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: ''
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'TimeoutError' ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: err.message || String(err)
    };
  }
}
