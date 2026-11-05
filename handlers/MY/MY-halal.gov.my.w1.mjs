export const meta = {
  task: 'MY-halal.gov.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'address', 'comp_code', 'expiry_dates'],
  canary: { found: 'Nestle Products Sdn. Bhd.', not_found: 'O2O Digital' },
};

export default async function lookup(keyword) {
  const postUrl = 'https://www.halal.gov.my/index.php?data=ZGlyZWN0b3J5L2luZGV4X2RpcmVjdG9yeTs7Ozs=';
  try {
    const params = new URLSearchParams();
    params.append('category', '');
    params.append('cari', keyword);
    params.append('search', '');

    const res = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.halal.gov.my/',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: postUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const html = await res.text();

    if (!html.includes('Nama & Alamat Syarikat') && !html.includes('Total Record : 0')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: postUrl,
        excerpt: 'Expected Halal directory search table not found',
      };
    }

    if (html.includes('Total Record : 0')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: postUrl,
        excerpt: `No halal certification records found for "${keyword}" (Total Record : 0).`,
      };
    }

    const rowRegex = /<tr class="[^"]*cursor-pointer[^"]*"[^>]*onclick="openModal\('([^']+)'[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    const records = [];
    let bestExcerpt = '';

    while ((match = rowRegex.exec(html)) !== null) {
      const detailLink = match[1];
      const rowContent = match[2];

      const compCodeMatch = detailLink.match(/comp_code=([^&]+)/);
      const compCode = compCodeMatch ? compCodeMatch[1] : '';

      const nameMatch = rowContent.match(/<span class="company-name">([\s\S]*?)<\/span>/i);
      const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

      const addrMatch = rowContent.match(/<span class="company-address">([\s\S]*?)<\/span>/i);
      const address = addrMatch ? addrMatch[1].replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

      const expiryMatch = rowContent.match(/<td class="text-center py-6">([\s\S]*?)<\/td>/i);
      const expiry = expiryMatch ? expiryMatch[1].replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

      const cleanExcerpt = rowContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!bestExcerpt) bestExcerpt = cleanExcerpt;

      records.push({
        name,
        address,
        comp_code: compCode,
        expiry_dates: expiry,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: postUrl,
        excerpt: `No rows found for "${keyword}".`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: postUrl,
      excerpt: bestExcerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: postUrl,
      excerpt: String(err),
    };
  }
}
