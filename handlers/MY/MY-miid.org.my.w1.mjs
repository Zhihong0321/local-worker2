export const meta = {
  task: 'MY-miid.org.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'membership_no', 'category'],
  canary: {
    found: 'OOI DESIGN & ASSOCIATES SDN BHD',
    not_found: 'Dezeno',
  },
};

/** Look one interior design firm or practitioner up on MIID Membership Roll. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      status: 'couldnt_check',
      reason: 'invalid_input',
      records: [],
      source_url: 'https://miid.org.my/membership-roll/',
      excerpt: '',
    };
  }

  const cleanKeyword = keyword.trim().toLowerCase();
  const searchUrl = `https://miid.org.my/wp-json/wp/v2/search?search=${encodeURIComponent(keyword.trim())}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const searchResults = await res.json();
    if (!Array.isArray(searchResults)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Search result is not an array',
      };
    }

    if (searchResults.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: 'No records matching search query',
      };
    }

    // Filter to membership roll pages
    const memberPages = searchResults.filter(r => r.url && (r.url.includes('membership') || r.url.includes('body-corporate')));
    if (memberPages.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: 'Matches exist on site but none in membership roll',
      };
    }

    // Fetch the matched page to extract row details
    const records = [];
    let sourceUrl = memberPages[0].url;
    let excerpt = '';

    for (const page of memberPages) {
      const pageRes = await fetch(`https://miid.org.my/wp-json/wp/v2/pages/${page.id}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!pageRes.ok) continue;
      const pageData = await pageRes.json();
      const content = pageData.content?.rendered || '';

      // Match table rows
      const rowMatches = [...content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      for (const rm of rowMatches) {
        const rowText = rm[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        if (rowText.toLowerCase().includes(cleanKeyword) || cleanKeyword.split(/\s+/).every(w => rowText.toLowerCase().includes(w))) {
          // Extract cells
          const cells = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
          if (cells.length >= 2) {
            const rawName = cells[1] || cells[2] || rowText;
            records.push({
              name: rawName.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
              membership_no: cells[cells.length - 1],
              category: page.title || 'MIID Member',
            });
            if (!excerpt) {
              excerpt = rowText;
            }
          }
        }
      }
      if (records.length > 0) {
        sourceUrl = page.url;
        break;
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: excerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: 'No exact company row matched in membership roll',
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: searchUrl,
      excerpt: e.message || 'Fetch failed',
    };
  }
}
