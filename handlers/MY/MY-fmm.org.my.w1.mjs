export const meta = {
  task: 'MY-fmm.org.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'ssm_number', 'phone', 'address', 'website'],
  canary: { found: 'Multi-Trans Sdn Bhd', not_found: 'O2O Digital' },
};

export default async function lookup(keyword) {
  const url = `https://www.fmm.org.my/Member/MemberList?keyword=${encodeURIComponent(keyword)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

    if (!html.includes('Member/MemberList') && !html.includes('company-name')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: url,
        excerpt: 'Page missing expected MemberList structure or markers',
      };
    }

    if (html.includes('No records to display.')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: 'No records to display.',
      };
    }

    const cardRegex = /<div class="vstack bg-light rounded-3 p-4 h-100"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
    let match;
    const records = [];
    let bestExcerpt = '';

    const lowerKw = keyword.toLowerCase();

    while ((match = cardRegex.exec(html)) !== null) {
      const cardHtml = match[1];

      const nameMatch = cardHtml.match(/<div class="company-name"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
      const rawName = nameMatch ? nameMatch[1].trim() : '';

      if (!rawName.toLowerCase().includes(lowerKw) && !cardHtml.toLowerCase().includes(lowerKw)) {
        continue;
      }

      const ssmMatch = rawName.match(/\(([^)]+)\)$/);
      const ssm = ssmMatch ? ssmMatch[1].trim() : '';
      const name = ssmMatch ? rawName.replace(/\s*\([^)]+\)$/, '').trim() : rawName;

      const phoneMatch = cardHtml.match(/bi-telephone-fill[\s\S]*?<span class="contact-info-text"[^>]*>([^<]+)<\/span>/i);
      const phone = phoneMatch ? phoneMatch[1].trim() : '';

      const addrMatch = cardHtml.match(/bi-geo-alt[\s\S]*?<span class="contact-info-text"[^>]*>([^<]+)<\/span>/i);
      const address = addrMatch ? addrMatch[1].replace(/&amp;/g, '&').trim() : '';

      const webMatch = cardHtml.match(/bi-globe[\s\S]*?<a[^>]*href="([^"]+)"/i);
      const website = webMatch ? webMatch[1].trim() : '';

      const cleanExcerpt = cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!bestExcerpt) bestExcerpt = cleanExcerpt;

      records.push({
        name,
        ssm_number: ssm,
        phone,
        address,
        website,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `No matching records found for keyword "${keyword}"`,
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
