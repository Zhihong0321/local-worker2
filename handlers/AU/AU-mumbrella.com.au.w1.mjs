export const meta = {
  task: 'AU-mumbrella.com.au',
  want: 'w1',
  tier: 1,
  method: 'get',
  input: 'company name',
  fields: ['title', 'url', 'date'],
  canary: { found: 'Thinkerbell', not_found: 'Digital Next' },
};

export default async function lookup(keyword) {
  const cleanKw = keyword.trim();
  const searchUrl = `https://mumbrella.com.au/?s=${encodeURIComponent('"' + cleanKw + '"')}`;

  try {
    const res = await fetch(searchUrl, {
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
        source_url: searchUrl,
        excerpt: `HTTP status ${res.status}`
      };
    }

    const html = await res.text();

    if (!html.includes('Search Results for') && !html.includes('entry-article-grid') && !html.includes('feed/rss2')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Expected search results template markers not found'
      };
    }

    const articleMatches = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map(m => m[0]);

    const records = [];
    for (const art of articleMatches) {
      const linkMatch = art.match(/<a[^>]*class="[^"]*entry-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
                        art.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const dateMatch = art.match(/<div[^>]*class="[^"]*entry-meta[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

      if (linkMatch) {
        const title = linkMatch[2]
          .replace(/&#038;/g, '&')
          .replace(/&amp;/g, '&')
          .replace(/&#039;/g, "'")
          .replace(/<[^>]+>/g, '')
          .trim();
        records.push({
          title,
          url: linkMatch[1],
          date: dateMatch ? dateMatch[1].replace(/<[^>]+>/g, '').trim() : ''
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `No articles or awards found for "${cleanKw}"`
      };
    }

    const excerpt = `Found ${records.length} result(s): ` + records.slice(0, 3).map(r => r.title).join('; ');

    return {
      status: 'found',
      reason: '',
      records: records.slice(0, 20),
      source_url: searchUrl,
      excerpt: excerpt.slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'TimeoutError' ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: err.message || String(err)
    };
  }
}
