export const meta = {
  task: 'AU-abr.business.gov.au',
  want: 'w1',
  tier: 2,
  method: 'get',
  input: 'company name',
  fields: ['name', 'abn', 'entity_name', 'entity_type', 'abn_status', 'gst', 'location', 'business_names'],
  canary: { found: 'Digital Next', not_found: 'Dezeno' },
};

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const searchUrl = `https://abr.business.gov.au/Search/ResultsActive?SearchText=${encodeURIComponent(keyword)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('Search results') && !html.includes('ABN Lookup')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: html.slice(0, 300) };
    }

    const tableMatch = html.match(/<table[\s\S]*?<\/table>/)?.[0] || '';
    const rowMatches = tableMatch.match(/<tr[\s\S]*?<\/tr>/g) || [];

    const kwNorm = normalize(keyword);
    let matchedAbnUrl = null;
    let matchedName = '';

    for (let i = 1; i < rowMatches.length; i++) {
      const row = rowMatches[i];
      const cols = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(cleanText);
      if (cols.length >= 2) {
        const rowName = cols[1];
        const rowNameNorm = normalize(rowName);
        if (rowNameNorm === kwNorm || rowNameNorm.includes(kwNorm) || kwNorm.includes(rowNameNorm)) {
          const linkMatch = row.match(/href="([^"]*\/ABN\/View\?[^"]*)"/i);
          if (linkMatch) {
            matchedAbnUrl = new URL(linkMatch[1], 'https://abr.business.gov.au').href;
            matchedName = rowName;
            break;
          }
        }
      }
    }

    if (!matchedAbnUrl) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Found 0 matching active ABN records for ${keyword}`
      };
    }

    // Step 2: Fetch detail page
    const detailRes = await fetch(matchedAbnUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!detailRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: matchedAbnUrl, excerpt: `HTTP ${detailRes.status}` };
    }

    const detailHtml = await detailRes.text();
    const abnMatch = detailHtml.match(/Current details for ABN\s*([\d\s]+)/i) || detailHtml.match(/abn=([\d]+)/i);
    const abnVal = abnMatch ? abnMatch[1].trim() : '';

    const entityNameMatch = detailHtml.match(/Entity name:[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    const entityName = entityNameMatch ? cleanText(entityNameMatch[1]) : matchedName;

    const abnStatusMatch = detailHtml.match(/ABN status:[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    const abnStatus = abnStatusMatch ? cleanText(abnStatusMatch[1]) : '';

    const entityTypeMatch = detailHtml.match(/Entity type:[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    const entityType = entityTypeMatch ? cleanText(entityTypeMatch[1]) : '';

    const gstMatch = detailHtml.match(/Goods &amp; Services Tax \(GST\):[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    const gst = gstMatch ? cleanText(gstMatch[1]) : '';

    const locMatch = detailHtml.match(/Main business location:[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    const location = locMatch ? cleanText(locMatch[1]) : '';

    const bnames = [];
    const bnameSection = detailHtml.match(/Business name[\s\S]*?From[\s\S]*?<\/tr>([\s\S]*?)<\/table>/i);
    if (bnameSection) {
      const bRows = bnameSection[1].match(/<tr[\s\S]*?<\/tr>/g) || [];
      for (const br of bRows) {
        const bCols = (br.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(cleanText);
        if (bCols.length >= 1 && bCols[0]) {
          bnames.push(bCols[0]);
        }
      }
    }

    return {
      status: 'found',
      reason: '',
      records: [{
        name: matchedName,
        abn: abnVal,
        entity_name: entityName,
        entity_type: entityType,
        abn_status: abnStatus,
        gst,
        location,
        business_names: bnames
      }],
      source_url: matchedAbnUrl,
      excerpt: cleanText(detailHtml).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `https://abr.business.gov.au/Search/ResultsActive?SearchText=${encodeURIComponent(keyword)}`,
      excerpt: String(err?.message || err)
    };
  }
}