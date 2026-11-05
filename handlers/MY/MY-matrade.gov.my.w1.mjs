export const meta = {
  task: 'MY-matrade.gov.my',
  want: 'w1',
  tier: 2,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'description', 'category'],
  canary: {
    found: 'MULTI-TRANS SDN BHD',
    not_found: 'DNE Logistics',
  },
};

/** Look one company up in MATRADE Products and Services Directories. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      status: 'couldnt_check',
      reason: 'invalid_input',
      records: [],
      source_url: 'https://www.matrade.gov.my',
      excerpt: '',
    };
  }

  const cleanKeyword = keyword.trim();
  const searchEndpoints = [
    {
      category: 'product',
      url: `https://myexport.matrade.gov.my/apps/mpd/product_search.php?search=${encodeURIComponent(cleanKeyword)}&choice=Company&option=word&advance=yes`,
    },
    {
      category: 'service',
      url: `https://myexport.matrade.gov.my/apps/msd/product_search.php?search=${encodeURIComponent(cleanKeyword)}&choice=Company&option=word&advance=yes`,
    },
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  const records = [];
  let finalSourceUrl = searchEndpoints[0].url;
  let excerpt = '';
  let seenAnyValidPage = false;

  for (const endpoint of searchEndpoints) {
    try {
      const res = await fetch(endpoint.url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        continue;
      }

      const html = await res.text();

      // Check layout marker
      const hasFoundMarker = html.includes('Company(s) Found');
      const hasNotFoundMarker = html.includes('No Company Found');

      if (!hasFoundMarker && !hasNotFoundMarker) {
        continue;
      }

      seenAnyValidPage = true;

      if (hasFoundMarker) {
        finalSourceUrl = endpoint.url;
        // Parse results: <a ... href="company_detail.php..."><b>COMPANY NAME</b></a>
        const matches = [...html.matchAll(/<td width="90%"><a[^>]*><b>([\s\S]*?)<\/b><\/a><\/td>[\s\S]*?<div class="col">([\s\S]*?)<\/div>/gi)];
        for (const m of matches) {
          const compName = m[1].replace(/<[^>]+>/g, '').trim();
          const desc = m[2].replace(/<[^>]+>/g, '').trim();
          records.push({
            name: compName,
            description: desc,
            category: endpoint.category,
          });
          if (!excerpt) {
            excerpt = `${compName} | ${desc}`;
          }
        }
      }
    } catch (e) {
      // Individual endpoint timeout/network error
    }

    if (records.length > 0) {
      break;
    }
  }

  if (!seenAnyValidPage && records.length === 0) {
    return {
      status: 'couldnt_check',
      reason: 'http_error',
      records: [],
      source_url: searchEndpoints[0].url,
      excerpt: 'Could not connect to MATRADE directories',
    };
  }

  if (records.length > 0) {
    return {
      status: 'found',
      reason: '',
      records,
      source_url: finalSourceUrl,
      excerpt: excerpt.slice(0, 500),
    };
  }

  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: finalSourceUrl,
    excerpt: 'No Company Found',
  };
}
