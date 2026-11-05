export const meta = {
  task: 'SG-casetrust.case.org.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'scheme', 'validity', 'address'],
  canary: {
    found: 'Space Factor',
    not_found: 'RSM Singapore'
  }
};

export default async function lookup(keyword) {
  const source_url = 'https://casetrust.case.org.sg/Home/casetrustlist';
  try {
    const res = await fetch(source_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url,
        excerpt: `HTTP ${res.status}`
      };
    }

    const html = await res.text();
    if (!html.includes('Trading Name of Business') || !html.includes('Accreditation Type')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: html.slice(0, 500)
      };
    }

    const normKey = String(keyword).toLowerCase().replace(/[^a-z0-9]/g, '');
    const rowRegex = /<tr>\s*<td>(\d+)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    const records = [];
    let matchExcerpt = '';

    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const name = m[2].replace(/<[^>]+>/g, '').trim();
      const scheme = m[3].replace(/<[^>]+>/g, '').trim();
      const address = m[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const validity = m[5].replace(/<[^>]+>/g, '').trim();

      const normName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normName.includes(normKey)) {
        if (!matchExcerpt) {
          matchExcerpt = m[0].replace(/\s+/g, ' ').slice(0, 500);
        }
        records.push({
          name,
          scheme,
          validity,
          address
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: ''
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url,
      excerpt: matchExcerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url,
      excerpt: String(err).slice(0, 500)
    };
  }
}
