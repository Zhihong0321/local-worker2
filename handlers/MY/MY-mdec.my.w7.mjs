export const meta = {
  task: 'MY-mdec.my',
  want: 'w7',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'category', 'id'],
  canary: { found: 'Circle Studio Sdn. Bhd.', not_found: 'Dezeno' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const url = 'https://www.mdec.my/industrycatalogue/companies';
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
        excerpt: '__NEXT_DATA__ script not found on industrycatalogue page'
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

    const companies = parsed.props?.pageProps?.companies;
    if (!Array.isArray(companies)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'companies array missing from pageProps'
      };
    }

    const lowerKw = keyword.toLowerCase();
    const records = [];
    let bestExcerpt = '';

    for (const c of companies) {
      const name = c.Name || '';
      const category = Array.isArray(c.Category) ? c.Category.join(', ') : (c.Category || '');
      const text = `${name} ${category}`;

      if (text.toLowerCase().includes(lowerKw)) {
        if (!bestExcerpt) bestExcerpt = `${name} (${category})`.slice(0, 500);
        records.push({
          name,
          category,
          id: c.Id
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `No digital creative content studio records found for "${keyword}" in DCC catalogue.`
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
