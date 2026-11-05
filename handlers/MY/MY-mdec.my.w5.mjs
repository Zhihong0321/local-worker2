export const meta = {
  task: 'MY-mdec.my',
  want: 'w5',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'url', 'roc_number', 'year'],
  canary: { found: '3NOVA SDN. BHD.', not_found: 'Dezeno' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const csvUrl = 'https://www.mdec.my/api/media/file/%5BCRQ-0009196%5D%20MD%20Company%20list%20as%20of%20Q3%202026_Faiz%20Hamizan%20Bin%20Muh(Sheet1).csv';
  try {
    const res = await fetch(csvUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: csvUrl,
        excerpt: `HTTP status ${res.status}`
      };
    }

    const text = await res.text();
    if (!text.includes('Companyname') || !text.includes('ROCNo')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: csvUrl,
        excerpt: 'CSV header missing expected Companyname / ROCNo columns'
      };
    }

    const lines = text.split(/\r?\n/);
    const lowerKw = keyword.toLowerCase();
    const records = [];
    let bestExcerpt = '';

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.toLowerCase().includes(lowerKw)) {
        // Parse CSV line
        // Format: Companyname,URL,ROCNo,Year
        const parts = line.split(',');
        const companyName = parts[0] || '';
        const url = parts[1] || '';
        const rocNo = parts.slice(2, -1).join(',') || parts[2] || '';
        const year = parts[parts.length - 1] || '';

        if (!bestExcerpt) bestExcerpt = line.slice(0, 500);

        records.push({
          name: companyName,
          url: url !== '-' ? url : '',
          roc_number: rocNo,
          year: year
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: csvUrl,
        excerpt: `No Malaysia Digital status records found for "${keyword}".`
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: csvUrl,
      excerpt: bestExcerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: csvUrl,
      excerpt: String(err)
    };
  }
}
