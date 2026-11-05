export const meta = {
  task: 'MY-kancilawards.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['campaign', 'medal', 'category', 'agency', 'entry_url'],
  canary: { found: 'Dentsu (Malaysia) Sdn Bhd', not_found: 'Kingdom Digital' },
};

export default async function lookup(keyword) {
  const agencyIndexUrl = 'https://kancilawards.com/agency';
  try {
    const res = await fetch(agencyIndexUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: agencyIndexUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const html = await res.text();

    if (!html.includes('agencyList') && !html.includes('All Agencies')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: agencyIndexUrl,
        excerpt: 'Expected agencyList section not found on /agency',
      };
    }

    // Match all agency cards
    const agencyRegex = /<h3 class="title">([\s\S]*?)<\/h3>\s*<\/div>\s*<a class="card-link" href="([^"]+)"/gi;
    let match;
    const lowerKw = keyword.toLowerCase();
    let matchedAgency = null;

    while ((match = agencyRegex.exec(html)) !== null) {
      const name = match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      const url = match[2];

      if (name.toLowerCase().includes(lowerKw) || lowerKw.includes(name.toLowerCase())) {
        matchedAgency = { name, url };
        break;
      }
    }

    if (!matchedAgency) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: agencyIndexUrl,
        excerpt: `Agency "${keyword}" not found in Kancil Awards accredited agency roll.`,
      };
    }

    // Fetch the agency detail page to retrieve verified winning trophies
    const detailRes = await fetch(matchedAgency.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!detailRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: matchedAgency.url,
        excerpt: `Failed to fetch agency profile: HTTP ${detailRes.status}`,
      };
    }

    const detailHtml = await detailRes.text();

    const cardRegex = /<div class="card-small linked">([\s\S]*?)<\/div>\s*(?=<div class="card-small linked">|<\/div>\s*<\/div>\s*<\/section>|$)/gi;
    let cardMatch;
    const records = [];
    let bestExcerpt = '';

    while ((cardMatch = cardRegex.exec(detailHtml)) !== null) {
      const cardHtml = cardMatch[1];

      const medalMatch = cardHtml.match(/<span class="medal[^"]*">([\s\S]*?)<\/span>/i);
      const medal = medalMatch ? medalMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const titleMatch = cardHtml.match(/<h3 class="title">([\s\S]*?)<\/h3>/i);
      const campaign = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const categoryMatch = cardHtml.match(/<span class="category">([\s\S]*?)<\/span>/i);
      const category = categoryMatch ? categoryMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const linkMatch = cardHtml.match(/<a class="card-link" href="([^"]+)"/i);
      const entryUrl = linkMatch ? linkMatch[1] : matchedAgency.url;

      const cleanExcerpt = cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!bestExcerpt) bestExcerpt = cleanExcerpt;

      records.push({
        campaign,
        medal,
        category,
        agency: matchedAgency.name,
        entry_url: entryUrl,
      });
    }

    if (records.length === 0) {
      // Listed on agency page but no individual winning entries
      records.push({
        campaign: 'Agency Listing',
        medal: 'Participant',
        category: 'Agencies',
        agency: matchedAgency.name,
        entry_url: matchedAgency.url,
      });
      bestExcerpt = `Verified Kancil Awards accredited agency: ${matchedAgency.name}`;
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matchedAgency.url,
      excerpt: bestExcerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: agencyIndexUrl,
      excerpt: String(err),
    };
  }
}
