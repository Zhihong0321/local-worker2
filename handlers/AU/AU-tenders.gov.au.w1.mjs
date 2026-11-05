export const meta = {
  task: 'AU-tenders.gov.au',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['cn_id', 'supplier_name', 'agency', 'contract_value', 'publish_date', 'contract_period', 'category'],
  canary: {
    found: 'Pitcher Partners',
    not_found: 'Magellan Logistics'
  }
};

/**
 * Look up contract notices on AusTender for a company.
 * Plain HTTP GET via public search URL template.
 *
 * @param {string} keyword Company name
 * @returns {Promise<{status: string, reason: string, records: Array<object>, source_url: string, excerpt: string}>}
 */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.tenders.gov.au/',
      excerpt: 'Empty keyword provided'
    };
  }

  const cleanKeyword = keyword.trim();
  const searchUrl = `https://www.tenders.gov.au/Search/CnAdvancedSearch?SearchFrom=CnSearch&Type=Cn&AgencyStatus=-1&DateType=Publish%20Date&SupplierName=${encodeURIComponent(cleanKeyword)}`;

  try {
    let res;
    // Retry up to 2 times on 429 rate limit
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-AU,en;q=0.9'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (res.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
        continue;
      }
      break;
    }

    if (res.status === 403 || res.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP status ${res.status} returned by AusTender`
      };
    }

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP error ${res.status}: ${res.statusText}`
      };
    }

    const html = await res.text();

    // Verify page layout / expected markers
    if (!html.includes('AusTender') && !html.includes('Contract Notices')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Expected AusTender title or branding marker missing from response'
      };
    }

    // Check for "no results" condition
    if (html.includes('There are no results that match your selection.') || html.includes('0 Results') || html.includes('no results that match')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `There are no results that match your selection for "${cleanKeyword}"`
      };
    }

    // Extract records from listInner cards
    const parts = html.split(/<div class="box boxW listInner">/i);
    if (parts.length <= 1) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Neither no-results marker nor listInner result containers found'
      };
    }

    const records = [];
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i].split(/<\/div>\s*<\/div>\s*<\/div>/)[0];
      const descs = [...part.matchAll(/<div class="list-desc">([\s\S]*?)<\/div>\s*<\/div>/gi)].map(m => m[1]);

      let cnId = '';
      let agency = '';
      let publishDate = '';
      let category = '';
      let contractPeriod = '';
      let contractValue = '';
      let supplierName = '';

      for (const d of descs) {
        const labelMatch = d.match(/<span>([^<]+)<\/span>/i);
        const label = labelMatch ? labelMatch[1].trim().toLowerCase().replace(/:$/, '') : '';
        const valMatch = d.match(/<div class="list-desc-inner">([\s\S]*)/i);
        const val = valMatch ? valMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ') : '';

        if (label === 'cn id') cnId = val;
        else if (label === 'agency') agency = val;
        else if (label === 'publish date') publishDate = val;
        else if (label === 'category') category = val;
        else if (label === 'contract period') contractPeriod = val;
        else if (label === 'contract value (aud)') contractValue = val;
        else if (label === 'supplier name') supplierName = val;
      }

      if (cnId || supplierName) {
        records.push({
          cn_id: cnId,
          supplier_name: supplierName,
          agency,
          contract_value: contractValue,
          publish_date: publishDate,
          contract_period: contractPeriod,
          category
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `No valid contract notice records parsed for "${cleanKeyword}"`
      };
    }

    const first = records[0];
    const excerpt = `CN ID: ${first.cn_id} | Supplier: ${first.supplier_name} | Agency: ${first.agency} | Value: ${first.contract_value} | Date: ${first.publish_date}`;

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: excerpt.slice(0, 500)
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.code === 'ETIMEDOUT';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: `Error querying AusTender: ${err.message}`
    };
  }
}
