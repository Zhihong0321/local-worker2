export const meta = {
  task: 'AU-auda.org.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name'],
  canary: { found: 'Nexigen Digital Pty Ltd', not_found: 'Chromatix' },
};

export default async function lookup(keyword) {
  const url = 'https://www.auda.org.au/registrar-resources/list-of-au-accredited-registrars/';
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

    // Check for structural layout markers
    if (!html.includes('list-of-au-accredited-registrars') && !html.toLowerCase().includes('accredited registrars')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Expected accredited registrars heading or URL marker not found'
      };
    }

    // Find all list elements within unordered lists
    const ulMatches = html.match(/<ul[^>]*>([\s\S]*?)<\/ul>/gi) || [];
    let registrarList = [];
    for (const ul of ulMatches) {
      if (ul.includes('VentraIP') || ul.includes('GoDaddy')) {
        const lis = [...ul.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m =>
          m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
        ).filter(Boolean);
        if (lis.length > 0) {
          registrarList = lis;
          break;
        }
      }
    }

    if (registrarList.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Could not find registrar list items in page'
      };
    }

    const cleanKeyword = keyword.toLowerCase().trim();
    const matched = registrarList.filter(item => {
      const lower = item.toLowerCase();
      return lower.includes(cleanKeyword) || cleanKeyword.includes(lower);
    });

    if (matched.length > 0) {
      const idx = html.toLowerCase().indexOf(matched[0].toLowerCase());
      const excerpt = idx >= 0 ? html.slice(Math.max(0, idx - 100), Math.min(html.length, idx + 200)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : matched.join(', ');
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
