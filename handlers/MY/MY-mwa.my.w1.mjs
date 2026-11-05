export const meta = {
  task: 'MY-mwa.my',
  want: 'w1',
  tier: 2,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'details', 'source'],
  canary: {
    found: 'Pluto Communications Sdn Bhd',
    not_found: 'O2O Digital',
  },
};

/** Look one agency or company up in MWA Winners Archive. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      status: 'couldnt_check',
      reason: 'invalid_input',
      records: [],
      source_url: 'https://www.mwa.my/winners/',
      excerpt: '',
    };
  }

  const cleanKeyword = keyword.trim().toLowerCase();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  try {
    const [currRes, pastRes] = await Promise.all([
      fetch('https://www.mwa.my/winners/', { headers, signal: AbortSignal.timeout(15000) }),
      fetch('https://www.mwa.my/past-year-winners/', { headers, signal: AbortSignal.timeout(15000) }),
    ]);

    if (!currRes.ok || !pastRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: 'https://www.mwa.my/winners/',
        excerpt: `HTTP status curr:${currRes.status} past:${pastRes.status}`,
      };
    }

    const [currHtml, pastHtml] = await Promise.all([currRes.text(), pastRes.text()]);

    // Check layout markers
    if (!currHtml.includes('Site of The Year') || !pastHtml.includes('Past Year Winners')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: 'https://www.mwa.my/winners/',
        excerpt: 'Expected layout markers missing',
      };
    }

    const records = [];
    let sourceUrl = 'https://www.mwa.my/winners/';
    let excerpt = '';

    // Search current winners
    if (currHtml.toLowerCase().includes(cleanKeyword)) {
      sourceUrl = 'https://www.mwa.my/winners/';
      const idx = currHtml.toLowerCase().indexOf(cleanKeyword);
      excerpt = currHtml.slice(Math.max(0, idx - 100), idx + 200).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      records.push({
        name: keyword.trim(),
        details: 'Site of the Year / Web Excellence Winner',
        source: 'Current Winners (2025)',
      });
    }

    // Search past winners tables
    const rows = [...pastHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
    for (const r of rows) {
      const rowText = r[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      if (rowText.toLowerCase().includes(cleanKeyword)) {
        sourceUrl = 'https://www.mwa.my/past-year-winners/';
        if (!excerpt) {
          excerpt = rowText;
        }
        const cells = [...r[1].matchAll(/<td>([\s\S]*?)<\/td>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
        records.push({
          name: cells[cells.length - 1] || rowText,
          details: cells.join(' | '),
          source: 'Past Year Winners',
        });
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: excerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: 'https://www.mwa.my/winners/',
      excerpt: 'Company not listed in MWA current or past winners archive',
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: 'https://www.mwa.my/winners/',
      excerpt: e.message || 'Fetch failed',
    };
  }
}
