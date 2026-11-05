export const meta = {
  task: 'AU-australianinteriordesignawards.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  input: 'company name',
  fields: ['project', 'category', 'year', 'url'],
  canary: { found: 'Mim Design', not_found: 'Chromatix' },
};

export default async function lookup(keyword) {
  const url = `https://australianinteriordesignawards.com/gallery/search?q=${encodeURIComponent(keyword.trim())}`;
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

    // Check layout markers
    if (!html.includes('action="/gallery/search"') && !html.includes('action="&#x2F;gallery&#x2F;search"') && !html.includes('class="formfilter"')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Expected search form not found on gallery search page'
      };
    }

    const countMatch = html.match(/<h2[^>]*class="[^"]*gallery__category[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
    if (!countMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Could not find gallery category or result count header'
      };
    }

    const countText = countMatch[1].replace(/<[^>]+>/g, '').trim();
    if (countText.includes('Found 0 projects') || !html.includes('gallery__preview')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: countText
      };
    }

    // Extract records
    const itemRegex = /<a[^>]*class="[^"]*gallery__preview[^"]*"[^>]*href="([^"]+)"[\s\S]*?<h3[^>]*class="gallery__preview--title">([\s\S]*?)<\/h3>/gi;
    const records = [];
    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      const itemUrl = 'https://australianinteriordesignawards.com' + match[1].replace(/&#x2F;/g, '/');
      const titleRaw = match[2].replace(/&amp;/g, '&').replace(/<br\s*\/?>/gi, ' - ').replace(/<[^>]+>/g, '').trim();
      records.push({
        project: titleRaw,
        url: itemUrl
      });
    }

    const excerpt = countText + ': ' + records.slice(0, 3).map(r => r.project).join('; ');

    return {
      status: records.length > 0 ? 'found' : 'not_found',
      reason: '',
      records: records.slice(0, 20),
      source_url: url,
      excerpt: excerpt.slice(0, 500)
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
