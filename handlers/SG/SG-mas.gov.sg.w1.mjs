export const meta = {
  task: 'SG-mas.gov.sg',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['institution_name', 'licence_categories', 'website', 'phone', 'detail_url'],
  canary: {
    found: 'DBS BANK LTD.',
    not_found: 'Space Factor'
  }
};

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://eservices.mas.gov.sg/fid/institution',
        excerpt: ''
      };
    }

    const searchUrl = `https://eservices.mas.gov.sg/fid/institution?term=${encodeURIComponent(cleanKeyword)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP ${res.status} ${res.statusText}`
      };
    }

    const html = await res.text();

    if (!html.includes('header-inner-2') && !html.includes('Filter Result') && !html.includes('txtSearch')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: html.slice(0, 300)
      };
    }

    const cardRegex = /<div class="inner">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
    const cards = [];
    let match;

    while ((match = cardRegex.exec(html)) !== null) {
      const cardHtml = match[1];

      const nameMatch = cardHtml.match(/<a\b[^>]*href="([^"]*\/institution\/detail\/[^"]*)"[^>]*>\s*<h3 class="header-inner-2">([\s\S]*?)<\/h3>/i);
      if (!nameMatch) continue;

      const detailPath = nameMatch[1].trim();
      const name = decodeEntities(nameMatch[2].replace(/<[^>]+>/g, ''));

      // Extract categories
      const catMatches = [...cardHtml.matchAll(/class="FilterCategory"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '')));

      // Extract website
      const webMatch = cardHtml.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="font-resize"/i);
      const website = webMatch ? webMatch[1].trim() : '';

      // Extract phone
      const phoneMatch = cardHtml.match(/href="tel:([^"]+)"/i);
      const phone = phoneMatch ? phoneMatch[1].trim() : '';

      cards.push({
        institution_name: name,
        licence_categories: catMatches.join('; '),
        website,
        phone,
        detail_url: detailPath.startsWith('http') ? detailPath : `https://eservices.mas.gov.sg${detailPath}`
      });
    }

    // Filter to matches that contain the keyword
    const matched = cards.filter(c => {
      const normCard = c.institution_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normKw = cleanKeyword.toLowerCase().replace(/[^a-z0-9]/g, '');
      return normCard.includes(normKw) || normKw.includes(normCard);
    });

    if (matched.length > 0) {
      const excerptMatch = html.match(/<div class="inner">[\s\S]{0,400}/);
      const excerpt = excerptMatch ? excerptMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : matched[0].institution_name;

      return {
        status: 'found',
        reason: '',
        records: matched,
        source_url: searchUrl,
        excerpt
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: 'No matching institutions found'
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://eservices.mas.gov.sg/fid/institution',
      excerpt: err.message || String(err)
    };
  }
}
