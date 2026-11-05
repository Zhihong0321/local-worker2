export const meta = {
  task: 'MY-mdec.my',
  want: 'w6',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'title', 'sectors', 'tech_enablers', 'slug'],
  canary: { found: 'EQUAD TECHNOLOGIES SDN BHD', not_found: 'Dezeno' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const url = 'https://www.mdec.my/md-tech-navigator/tech-use-cases';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
      }
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
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!nextDataMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: '__NEXT_DATA__ script not found on tech-use-cases page'
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(nextDataMatch[1]);
    } catch (e) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: `Failed to parse __NEXT_DATA__: ${e.message}`
      };
    }

    const lists = parsed.props?.pageProps?.techNavigatorLists;
    if (!Array.isArray(lists)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'techNavigatorLists array missing from pageProps'
      };
    }

    const lowerKw = keyword.toLowerCase();
    const records = [];
    let bestExcerpt = '';

    for (const item of lists) {
      const company = item.CompanyName || '';
      const title = item.Title || '';
      const text = `${company} ${title} ${item.Sectors || ''} ${item.TechEnablers || ''}`;

      if (text.toLowerCase().includes(lowerKw)) {
        if (!bestExcerpt) bestExcerpt = `${company} - ${title}`.slice(0, 500);
        records.push({
          name: company,
          title: title,
          sectors: item.Sectors || '',
          tech_enablers: item.TechEnablers || '',
          slug: item.Slug || ''
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `No tech use cases found for "${keyword}" on MDEC MD Tech Navigator.`
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: bestExcerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: url,
      excerpt: String(err)
    };
  }
}
