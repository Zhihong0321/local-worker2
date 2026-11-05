export const meta = {
  task: 'MY-fmff.net',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'address', 'contact_person', 'phone', 'email'],
  canary: { found: '20Cube Logistics Sdn Bhd', not_found: 'O2O Digital' },
};

export default async function lookup(keyword) {
  const directoryUrl = 'https://www.fmff.net/membershipdirectory';
  try {
    const res = await fetch(directoryUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: directoryUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const html = await res.text();

    if (!html.includes('membershipdirectory') && !html.includes('<h5>')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: directoryUrl,
        excerpt: 'Page missing expected member listings or layout markers',
      };
    }

    const lowerKw = keyword.toLowerCase();
    const blockRegex = /<h5>([\s\S]*?)<\/h5>([\s\S]*?)(?=(?:<h5>|<div class="s_hr|$))/gi;
    let match;
    const records = [];
    let bestExcerpt = '';

    while ((match = blockRegex.exec(html)) !== null) {
      const name = match[1].replace(/<[^>]+>/g, '').trim();
      const content = match[2];

      const fullBlockText = `${name}\n${content.replace(/<[^>]+>/g, ' ')}`;

      if (name.toLowerCase().includes(lowerKw) || fullBlockText.toLowerCase().includes(lowerKw)) {
        const addrMatch = content.match(/<p>([\s\S]*?)<\/p>/i);
        const address = addrMatch ? addrMatch[1].replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

        const picMatch = content.match(/P\.I\.C:\s*([^<\n]+)/i);
        const contactPerson = picMatch ? picMatch[1].trim() : '';

        const phoneMatch = content.match(/(?:📞|Tel|Telephone)[\s\S]*?([0-9][0-9\-\s\(\)\+]{6,20})/i);
        const phone = phoneMatch ? phoneMatch[1].trim() : '';

        const emailMatch = content.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        const email = emailMatch ? emailMatch[1].trim() : '';

        const cleanExcerpt = fullBlockText.replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!bestExcerpt) bestExcerpt = cleanExcerpt;

        records.push({
          name,
          address,
          contact_person: contactPerson,
          phone,
          email,
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: directoryUrl,
        excerpt: `No entry matching "${keyword}" in FMFF membership directory.`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: directoryUrl,
      excerpt: bestExcerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: directoryUrl,
      excerpt: String(err),
    };
  }
}
