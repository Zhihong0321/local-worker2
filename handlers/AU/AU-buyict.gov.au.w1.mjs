export const meta = {
  task: 'AU-buyict.gov.au',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'legal_name', 'abn', 'approved_marketplaces'],
  canary: { found: 'Accenture', not_found: 'Chromatix' },
};

export default async function lookup(keyword) {
  const pageUrl = 'https://www.buyict.gov.au/public?id=seller_catalogue';
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // 1. Fetch initial HTML to get cookies and user token g_ck
    const initRes = await fetch(pageUrl, {
      headers: { ...headers, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15000)
    });

    if (!initRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: `HTTP status ${initRes.status}`
      };
    }

    const initCookies = initRes.headers.getSetCookie ? initRes.headers.getSetCookie() : [initRes.headers.get('set-cookie')];
    const cookieHeader = initCookies.filter(Boolean).map(c => c.split(';')[0]).join('; ');
    const initHtml = await initRes.text();

    const g_ck = initHtml.match(/window\.g_ck\s*=\s*['"]([a-f0-9]+)['"]/)?.[1];
    if (!g_ck) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: 'Could not extract user token g_ck from page'
      };
    }

    // 2. Fetch page definition from Service Portal API
    const pageApiUrl = 'https://www.buyict.gov.au/api/now/sp/page?id=seller_catalogue';
    const pageRes = await fetch(pageApiUrl, {
      headers: {
        ...headers,
        'Accept': 'application/json',
        'Cookie': cookieHeader,
        'X-UserToken': g_ck
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!pageRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageApiUrl,
        excerpt: `HTTP status ${pageRes.status}`
      };
    }

    const pageData = await pageRes.json();

    function findWidget(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.widget && obj.widget.id === 'seller_catalogue') return obj.widget;
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'object') {
          const found = findWidget(obj[k]);
          if (found) return found;
        }
      }
      return null;
    }

    const scWidget = findWidget(pageData);
    if (!scWidget || !scWidget.sys_id) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageApiUrl,
        excerpt: 'seller_catalogue widget not found in portal page definition'
      };
    }

    // 3. Post search query to seller_catalogue widget
    const serverData = JSON.parse(JSON.stringify(scWidget.data || {}));
    serverData.refresh_data = true;
    serverData.first_load = true;
    serverData.seller_search_term = keyword.trim();

    const widgetUrl = `https://www.buyict.gov.au/api/now/sp/widget/${scWidget.sys_id}`;
    const widgetRes = await fetch(widgetUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': cookieHeader,
        'X-UserToken': g_ck
      },
      body: JSON.stringify(serverData),
      signal: AbortSignal.timeout(15000)
    });

    if (!widgetRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: widgetUrl,
        excerpt: `HTTP status ${widgetRes.status}`
      };
    }

    const widgetData = await widgetRes.json();
    const allMps = widgetData.result?.data?.all_mps || widgetData.result?.all_mps;
    if (!Array.isArray(allMps)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: widgetUrl,
        excerpt: 'Expected all_mps array missing from widget response'
      };
    }

    const allMp = allMps.find(m => m.sys_id === 'all_marketplaces');
    const sellerCards = allMp?.seller_cards || [];

    if (sellerCards.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `No sellers found matching ${keyword}`
      };
    }

    const records = sellerCards.map(s => ({
      name: s.name,
      legal_name: s.legal_name || '',
      abn: s.abn || '',
      approved_marketplaces: (s.approved_marketplaces || []).map(m => m.label).join(', ')
    }));

    const first = sellerCards[0];
    const excerpt = `Found ${sellerCards.length} seller(s): ${first.name} (${first.legal_name || ''}) - ${first.abn || ''} - Marketplaces: ${(first.approved_marketplaces || []).map(m => m.label).join(', ')}`;

    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: excerpt.slice(0, 500)
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
