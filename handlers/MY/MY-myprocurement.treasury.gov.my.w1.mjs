export const meta = {
  task: 'MY-myprocurement.treasury.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['tender_no', 'title', 'ministry', 'decision_date', 'winner', 'price'],
  canary: {
    found: 'AVA WORLD CR SDN. BHD.',
    not_found: 'O2O Digital',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const pageUrl = 'https://myprocurement.treasury.gov.my/results/tender';
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!pageRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: `Failed to load tender results page: HTTP ${pageRes.status}`,
      };
    }

    const html = await pageRes.text();
    const tokenMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i);
    if (!tokenMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: 'CSRF token meta tag not found on tender results page',
      };
    }
    const token = tokenMatch[1];

    const cookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
    const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

    const params = new URLSearchParams({
      type: 'results',
      category: 'tender',
      itemsPerPage: '10',
      procurement_winner: keyword.trim(),
    });

    const apiUrl = `https://myprocurement.treasury.gov.my/procurements/fetch?${params.toString()}`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'X-CSRF-TOKEN': token,
        'Cookie': cookieHeader,
      },
    });

    if (!apiRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: apiUrl,
        excerpt: `API request failed with HTTP ${apiRes.status}`,
      };
    }

    const data = await apiRes.json();
    if (typeof data.total === 'undefined' || typeof data.html !== 'string') {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: apiUrl,
        excerpt: 'JSON response missing expected total or html properties',
      };
    }

    if (data.total === 0 || data.html.includes('Tiada rekod dijumpai.')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: apiUrl,
        excerpt: 'Tiada rekod dijumpai.',
      };
    }

    const cards = data.html.split(/<div x-data="\{ selected: false, open: true \}"/g).slice(1);
    const records = [];

    for (const card of cards) {
      const noTender = card.match(/No\.\s*Tender<\/span>:\s*([^\s<]+)/i)?.[1]?.trim() || '';
      const title = card.match(/<a\s+href="https:\/\/myprocurement\.treasury\.gov\.my\/results\/tender\/[^"]+">([^<]+)<\/a>/i)?.[1]?.trim() || '';
      const ministry = card.match(/Kementerian:<\/div>\s*<div[^>]*>([^<]+)<\/div>/i)?.[1]?.trim() || '';
      const date = card.match(/Tarikh Keputusan:<\/div>\s*<div[^>]*>([^<]+)<\/div>/i)?.[1]?.trim() || '';
      const winner = card.match(/<td class="text-start px-4 py-2 border border-primary\/30 w-full">\s*([^<]+)\s*<\/td>/i)?.[1]?.trim() || '';
      const price = card.match(/<td class="text-end px-4 py-2 border border-primary\/30">\s*([^<]+)\s*<\/td>/i)?.[1]?.trim() || '';

      if (winner) {
        records.push({
          tender_no: noTender,
          title,
          ministry,
          decision_date: date,
          winner,
          price: price ? `RM ${price}` : '',
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: apiUrl,
        excerpt: 'No matching winning bidder cards parsed.',
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: apiUrl,
      excerpt: `Found ${records.length} tender awards. Winner: ${records[0].winner}, Tender: ${records[0].tender_no}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://myprocurement.treasury.gov.my/',
      excerpt: err.message || String(err),
    };
  }
}
