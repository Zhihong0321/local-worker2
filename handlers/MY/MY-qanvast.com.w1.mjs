export const meta = {
  task: 'MY-qanvast.com',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'url', 'rating', 'reviews', 'projects', 'accreditation'],
  canary: {
    found: 'Doubble Interior Associates',
    not_found: 'O2O Digital',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const searchUrl = `https://qanvast.com/my/interior-designers?search=${encodeURIComponent(keyword.trim())}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
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

    const html = await res.text();

    if (!html.includes('company-list-results') && !html.includes('company-search-input')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Expected company list or search input marker not found on page',
      };
    }

    if (html.includes("We couldn't find what you are looking for") || html.includes("We couldn&#x27;t find what you are looking for")) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: "We couldn't find what you are looking for",
      };
    }

    const widgetRegex = /<div class="Widget_company__[^"]*">([\s\S]*?)(?=<div class="Widget_company__|$)/g;
    const cards = [...html.matchAll(widgetRegex)].map(m => m[1]);

    const records = [];
    for (const card of cards) {
      const nameMatch = card.match(/<h2[^>]*>([^<]+)<\/h2>/i);
      const name = nameMatch ? nameMatch[1].trim() : '';

      const linkMatch = card.match(/href="([^"]+)"\s+aria-label="[^"]*"/i) || card.match(/href="(https:\/\/qanvast\.com\/my\/interior-designers-architects\/[^"?]+)/i);
      const profileUrl = linkMatch ? linkMatch[1].split('?')[0] : '';

      const ratingMatch = card.match(/<span class="Widget_rating__[^"]*"><i[^>]*><\/i>\s*<!-- -->\s*([^<]+)<\/span>/i);
      const rating = ratingMatch ? ratingMatch[1].trim() : '';

      const reviewMatch = card.match(/<span class="Widget_count__[^"]*"><b>(\d+)<\/b>\s*<!-- -->\s*Reviews<\/span>/i);
      const reviews = reviewMatch ? reviewMatch[1] : '';

      const projectMatch = card.match(/<div class="Widget_project__[^"]*"><div><b>(\d+)<\/b>\s*<!-- -->\s*Projects<\/div>/i);
      const projects = projectMatch ? projectMatch[1] : '';

      const badgeMatch = card.match(/<div class="Widget_supertrust__[^"]*">[\s\S]*?<span>([^<]+)<\/span>/i) ||
                         card.match(/<div class="Widget_desktop-accreditations__[^"]*">([^<]+)<\/div>/i);
      const accreditation = badgeMatch ? badgeMatch[1].replace(/<!-- -->/g, '').trim() : '';

      if (name) {
        records.push({
          name,
          url: profileUrl,
          rating,
          reviews,
          projects,
          accreditation,
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: 'Zero firm cards matched query',
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `Found ${records.length} designer profile(s): ${records[0].name} (${records[0].projects ? records[0].projects + ' projects' : ''})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://qanvast.com/my/interior-designers',
      excerpt: err.message || String(err),
    };
  }
}
