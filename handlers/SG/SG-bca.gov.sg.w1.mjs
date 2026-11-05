export const meta = {
  task: 'SG-bca.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name or UEN',
  fields: ['name', 'uen', 'workhead', 'description', 'grade', 'expiry_date'],
  canary: {
    found: 'Space Factor',
    not_found: 'RSM Singapore',
  },
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function strip(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const normKw = normalize(keyword);
  if (!normKw) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: 'https://www.bca.gov.sg/eBACS/bca_directory',
      excerpt: '',
    };
  }

  try {
    const searchUrl = `https://www.bca.gov.sg/eBACS/BCA_DIRECTORY/Utility/SearchCompanies?searchKey=${encodeURIComponent(keyword.trim())}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!searchRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    let list;
    try {
      list = await searchRes.json();
    } catch {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    if (!Array.isArray(list)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    // Find company that matches the keyword
    const match = list.find(item => {
      const normName = normalize(item.companyName);
      const normUen = normalize(item.uenNo);
      return (
        normName === normKw ||
        normName.includes(normKw) ||
        normKw.includes(normName) ||
        normUen === normKw
      );
    });

    if (!match || !match.uenNo) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    // Detail page
    const detailUrl = `https://www.bca.gov.sg/eBACS/BCA_DIRECTORY/Company/CompanyDetails?uenNo=${encodeURIComponent(match.uenNo)}`;
    const detailRes = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!detailRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: detailUrl,
        excerpt: '',
      };
    }

    const detailHtml = await detailRes.text();
    if (!detailHtml.includes('Company Information') && !detailHtml.includes('Workhead')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: detailUrl,
        excerpt: '',
      };
    }

    const records = [];
    const rows = [...detailHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
    for (const r of rows) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => strip(c[1]));
      if (cells.length >= 4) {
        // cells: [workhead, description, grade, expiryDate]
        const workhead = cells[0].split(/\s+/)[0]; // e.g. CR06
        const description = cells[1];
        const grade = cells[2];
        const expiryDate = cells[3];
        records.push({
          name: match.companyName,
          uen: match.uenNo,
          workhead,
          description,
          grade,
          expiry_date: expiryDate,
        });
      }
    }

    // If no workhead rows found in table, record the company with its basic info
    if (records.length === 0) {
      records.push({
        name: match.companyName,
        uen: match.uenNo,
        workhead: '',
        description: '',
        grade: '',
        expiry_date: '',
      });
    }

    const excerpt = `Company: ${match.companyName} (${match.uenNo}), Workhead: ${records[0].workhead} Grade: ${records[0].grade} Expiry: ${records[0].expiry_date}`;

    return {
      status: 'found',
      reason: '',
      records,
      source_url: detailUrl,
      excerpt: excerpt.slice(0, 500),
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'http_error',
      records: [],
      source_url: 'https://www.bca.gov.sg/eBACS/bca_directory',
      excerpt: '',
    };
  }
}
