export const meta = {
  task: 'MY-lam.gov.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'registration_number', 'address', 'contact'],
  canary: { found: 'Abd Aziz Bin Ibrahim', not_found: 'Dezeno' },
};

export default async function lookup(keyword) {
  const url = 'https://www.lam.gov.my/search-member?atype=ID';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: url,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const html = await res.text();

    if (!html.includes('table table-hover') && !html.includes('Name & Registration Number')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Expected LAM members table not found on page',
      };
    }

    const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
    let match;
    const records = [];
    let bestExcerpt = '';
    const lowerKw = keyword.toLowerCase();

    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[1];
      if (!rowHtml.includes('special-text')) continue;

      const nameMatch = rowHtml.match(/<div class="special-text">([\s\S]*?)<\/div>/i);
      const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const regMatch = rowHtml.match(/<\/div>\s*([^<\n\r]+)/i);
      const regNo = regMatch ? regMatch[1].trim() : '';

      const addrMatch = rowHtml.match(/<td class="daddress">([\s\S]*?)<\/td>/i);
      const address = addrMatch ? addrMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

      const contactMatch = rowHtml.match(/<td class="dcontact">([\s\S]*?)<\/td>/i);
      const contact = contactMatch ? contactMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

      const combinedText = `${name} ${regNo} ${address}`;
      if (combinedText.toLowerCase().includes(lowerKw)) {
        const cleanExcerpt = rowHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!bestExcerpt) bestExcerpt = cleanExcerpt;

        records.push({
          name,
          registration_number: regNo,
          address,
          contact,
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `No registered interior designer records found for "${keyword}" on LAM register.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: bestExcerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: url,
      excerpt: String(err),
    };
  }
}