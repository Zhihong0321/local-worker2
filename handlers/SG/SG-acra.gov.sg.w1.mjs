export const meta = {
  task: 'SG-acra.gov.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'accountant or accounting firm name',
  fields: ['name', 'action', 'year', 'url'],
  canary: {
    found: 'Mr R Rahul Raj',
    not_found: 'RSM Singapore',
  },
};

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\b(mr|ms|mrs|mdm|dr)\b/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function strip(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Look one company or accountant up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = 'https://www.acra.gov.sg/manage/public-accountant-accounting-entity/regulation-compliance/regulatory-notices/disciplinary-proceedings/';
  try {
    const target = normalize(keyword);
    if (!target) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const res = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const html = await res.text();
    if (!html.includes('Disciplinary proceeding') && !html.includes('disciplinary-proceedings')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
    if (tables.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const allRecords = [];
    for (const table of tables) {
      const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      let currentYear = '';
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)];
        if (cells.length < 2) continue;
        const yearText = strip(cells[0][1]);
        if (/^\d{4}$/.test(yearText)) {
          currentYear = yearText;
        }
        const cellHtml = cells[1][1];
        const linkMatches = [...cellHtml.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
        for (const lm of linkMatches) {
          const href = lm[1];
          const rawLinkText = strip(lm[2]).replace(/\(opens in new tab\)/gi, '').trim();
          const parts = rawLinkText.split(/[–\-]/);
          const name = parts[0]?.trim();
          const action = parts[1]?.trim() || '';
          if (name) {
            allRecords.push({
              name,
              action,
              year: currentYear,
              url: href,
              raw: rawLinkText,
            });
          }
        }
      }
    }

    const matches = [];
    let matchExcerpt = '';
    for (const r of allRecords) {
      const normName = normalize(r.name);
      if (normName && (normName.includes(target) || target.includes(normName))) {
        matches.push({
          name: r.name,
          action: r.action,
          year: r.year,
          url: r.url,
        });
        if (!matchExcerpt) {
          matchExcerpt = `${r.year}: ${r.raw} (${r.url})`;
        }
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: matchExcerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: '',
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'http_error',
      records: [],
      source_url: sourceUrl,
      excerpt: '',
    };
  }
}
