export const meta = {
  task: 'SG-prod.sgnic.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'website', 'tel'],
  canary: { found: 'Singnet Pte Ltd', not_found: 'Verz Design' }
};

export default async function lookup(keyword) {
  const source_url = 'https://www.sgnic.sg/domain-registration/list-of-registrars';
  try {
    const res = await fetch(source_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url,
        excerpt: `HTTP status ${res.status}`
      };
    }

    const html = await res.text();

    if (!html.includes('Accredited Registrars') && !html.includes('List of Registrars')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: 'Expected registrar listing header not found in HTML'
      };
    }

    const regex = /<h3>([^<]+)<\/h3>[\s\S]*?<ul>([\s\S]*?)<\/ul>/gi;
    const registrars = [];
    let m;
    while ((m = regex.exec(html)) !== null) {
      const name = m[1].trim();
      const listContent = m[2];
      const websiteMatch = listContent.match(/Website:\s*<a[^>]*href=['"]([^'"]+)['"]/i);
      const telMatch = listContent.match(/Tel:\s*([^<]+)/i);
      registrars.push({
        name,
        website: websiteMatch ? websiteMatch[1].trim() : '',
        tel: telMatch ? telMatch[1].trim() : '',
        raw: m[0]
      });
    }

    if (registrars.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: 'No registrar items extracted from page'
      };
    }

    const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = clean(keyword);
    // Boundary match or word token match
    const matched = registrars.filter(r => {
      const cName = clean(r.name);
      return cName.includes(target) || target.split(' ').filter(w => !['pte', 'ltd', 'inc', 'co', 'the', 's'].includes(w)).every(w => w.length > 2 && cName.includes(w));
    });

    if (matched.length > 0) {
      const rec = matched[0];
      return {
        status: 'found',
        reason: '',
        records: matched.map(r => ({ name: r.name, website: r.website, tel: r.tel })),
        source_url,
        excerpt: rec.raw.slice(0, 500)
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: ''
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: err.message
    };
  }
}
