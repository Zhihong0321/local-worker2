export const meta = {
  task: 'MY-sc.com.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['auditor', 'nature', 'action', 'date', 'description'],
  canary: {
    found: 'TGS TW PLT',
    not_found: 'YYC Advisors',
  },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const pageUrl = 'https://www.sc.com.my/aob/aobs-sanctions';
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: `HTTP status ${res.status}`,
      };
    }

    const html = await res.text();

    if (!html.includes('table-with-header') && !html.includes("Date of AOB's Action")) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: 'Expected AOB sanctions table marker not found',
      };
    }

    const cleanKeyword = keyword.trim().toLowerCase();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: 'Empty search keyword',
      };
    }

    // Parse table rows
    const rows = [...html.matchAll(/<tr>\s*<td[^>]*>(\d+)\.?<\/td>([\s\S]*?)<\/tr>/gi)];
    const records = [];

    for (const r of rows) {
      const tds = [...r[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
      );
      if (tds.length >= 4) {
        const nature = tds[0];
        const auditor = tds[1];
        const description = tds[2];
        const action = tds[3];
        const date = tds[4] || '';

        const fullRowText = `${nature} ${auditor} ${description} ${action} ${date}`.toLowerCase();
        if (fullRowText.includes(cleanKeyword)) {
          records.push({
            auditor,
            nature,
            action,
            date,
            description: description.slice(0, 200),
          });
        }
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: 'No AOB sanctions or reprimands found matching keyword.',
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: `Found ${records.length} AOB sanction(s): ${records[0].auditor} - ${records[0].action}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.sc.com.my/aob/aobs-sanctions',
      excerpt: err.message || String(err),
    };
  }
}
