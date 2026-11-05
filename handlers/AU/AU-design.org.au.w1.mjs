export const meta = {
  task: 'AU-design.org.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company or designer name',
  fields: ['name', 'business', 'industry', 'website', 'location'],
  canary: { found: 'Generate Interiors', not_found: 'Alexander &CO.' },
};

export default async function lookup(keyword) {
  const pageUrl = 'https://www.design.org.au/find-a-designer';
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    // 1. Fetch find-a-designer page to get box ID and check layout
    const pageRes = await fetch(pageUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (!pageRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: `HTTP status ${pageRes.status}`
      };
    }

    const html = await pageRes.text();
    if (!html.includes('Find an Accredited Designer') && !html.includes('communitybox-target')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: 'Expected DIA Accredited Designer content or communitybox container missing'
      };
    }

    const boxMatch = html.match(/id="communitybox-target"[^>]*box="([^"]+)"/i) || html.match(/box="([a-f0-9\-]+)"/i);
    const boxId = boxMatch ? boxMatch[1] : '40506281-5438-47b2-85a0-c85dd97165a4';

    // 2. Query bootstrap endpoint for cache code
    const bsUrl = 'https://cfapi.communitybox.co/get/embed/bootstrap/data';
    const bsRes = await fetch(bsUrl, {
      method: 'POST',
      headers: {
        'User-Agent': headers['User-Agent'],
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        box: boxId,
        origin: pageUrl
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!bsRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: bsUrl,
        excerpt: `HTTP status ${bsRes.status}`
      };
    }

    const bsData = await bsRes.json();
    const cachecode = bsData.cachecode;
    if (!cachecode) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: bsUrl,
        excerpt: 'No cachecode in communitybox bootstrap response'
      };
    }

    // 3. Fetch cached directory database
    const dbUrl = `https://cdn.communitybox.co/directory/${boxId}/${cachecode}/db-${cachecode}`;
    const dbRes = await fetch(dbUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (!dbRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: dbUrl,
        excerpt: `HTTP status ${dbRes.status}`
      };
    }

    const dbData = await dbRes.json();
    const entries = dbData.details?.entries;
    if (!Array.isArray(entries)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: dbUrl,
        excerpt: 'Expected entries array missing in communitybox database'
      };
    }

    const cleanKw = keyword.toLowerCase().trim();
    const matched = [];

    for (const entry of entries) {
      const v = entry.value || {};
      const business = (v['f3f1f97d-46eb-4ccc-aff7-e1310f40b540'] || '').trim();
      const first = (v['f31ad8cc-44a2-4ca4-a798-875d11f10dcd'] || '').trim();
      const last = (v['55e06469-ca77-4840-ba67-e3bca2a36e85'] || '').trim();
      const fullName = `${first} ${last}`.trim();
      const industry = (v['e323deb3-a6cc-40a8-888b-23717a7bedc4'] || '').trim();
      const website = (v['803eed9e-0104-4d8e-b4fa-dd6bb3ae28e4'] || '').trim();
      const loc = v['2d88a823-7e1d-4d13-94cd-917a08c43209'];
      const location = loc ? (loc.formatted_address || loc.msp_address || '') : '';

      const searchTarget = `${business} ${fullName}`.toLowerCase();
      if (searchTarget.includes(cleanKw) || cleanKw.includes(business.toLowerCase()) && business.length > 3) {
        matched.push({
          name: fullName,
          business,
          industry,
          website,
          location
        });
      }
    }

    if (matched.length > 0) {
      const first = matched[0];
      const excerpt = `Found ${matched.length} DIA Accredited Designer(s): ${first.name} - ${first.business} (${first.industry}) Location: ${first.location}`;
      return {
        status: 'found',
        reason: '',
        records: matched,
        source_url: pageUrl,
        excerpt: excerpt.slice(0, 500)
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `No DIA Accredited Designers found matching "${keyword}"`
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'TimeoutError' ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl,
      excerpt: err.message || String(err)
    };
  }
}
