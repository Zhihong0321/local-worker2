export const meta = {
  task: 'MY-d-awards.com.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'award', 'campaign', 'page_title'],
  canary: { found: 'Kingdom Digital', not_found: 'O2O Digital' },
};

export default async function lookup(keyword) {
  try {
    const searchUrl = `https://d-awards.com.my/home/wp-json/wp/v2/search?search=${encodeURIComponent(keyword)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!searchRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP status ${searchRes.status}`,
      };
    }

    let searchData;
    try {
      searchData = await searchRes.json();
    } catch {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Failed to parse search API response as JSON',
      };
    }

    if (!Array.isArray(searchData)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Search API did not return an array',
      };
    }

    if (searchData.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `No search results found for "${keyword}"`,
      };
    }

    // Filter to winner/award pages if possible, or search across matching pages
    const winnerPages = searchData.filter(item => 
      item.url && (item.url.includes('winner') || item.title.toLowerCase().includes('winner'))
    );
    const candidatePages = winnerPages.length > 0 ? winnerPages : searchData;

    const records = [];
    let bestSourceUrl = searchUrl;
    let bestExcerpt = '';

    const lowerKw = keyword.toLowerCase();

    for (const pageItem of candidatePages) {
      try {
        const pageRes = await fetch(pageItem.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        if (!pageRes.ok) continue;

        const html = await pageRes.text();
        const lowerHtml = html.toLowerCase();
        const kwIdx = lowerHtml.indexOf(lowerKw);

        if (kwIdx !== -1) {
          bestSourceUrl = pageItem.url;
          
          // Extract award trophy if present nearby
          const segmentStart = Math.max(0, kwIdx - 500);
          const segmentEnd = Math.min(html.length, kwIdx + 500);
          const segment = html.slice(segmentStart, segmentEnd);

          const awardMatch = segment.match(/(GOLD|SILVER|BRONZE|GRAND\s*PRIX|FINALIST|MERIT)/i);
          const award = awardMatch ? awardMatch[1].toUpperCase() : 'Award Winner';

          // Extract campaign title from nearby h3 or strong
          const h3Match = segment.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
          const campaign = h3Match ? h3Match[1].replace(/<[^>]+>/g, '').trim() : '';

          // Clean excerpt text
          const cleanText = segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          bestExcerpt = cleanText.slice(0, 500);

          records.push({
            name: keyword,
            award,
            campaign,
            page_title: pageItem.title,
          });
          break;
        }
      } catch {
        continue;
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: bestSourceUrl,
        excerpt: `Found pages for "${keyword}" but no specific winner citation located in page content.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: bestSourceUrl,
      excerpt: bestExcerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: 'https://d-awards.com.my/',
      excerpt: String(err),
    };
  }
}
