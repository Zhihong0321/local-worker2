export const meta = {
  task: 'SG-www1.bca.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'uen', 'listing_code', 'discipline', 'panel', 'tendering_limit'],
  canary: {
    found: 'AEDAS PTE. LTD.',
    not_found: 'RSM Singapore',
  },
};

const DISCIPLINE_MAP = {
  AR: 'Architectural',
  CS: 'Civil / Structural',
  ME: 'Mechanical & Electrical',
  QS: 'Quantity Surveying',
  PM: 'Project Management',
};

const LIMIT_MAP = {
  AR: {
    '01': '> S$16M',
    '02': '> S$5M to S$50M',
    '03': 'Up to S$16M',
    '04': 'Up to S$5M',
  },
  CS: {
    '01': '> S$16M',
    '02': '> S$5M to S$50M',
    '03': 'Up to S$16M',
    '04': 'Up to S$5M',
  },
  ME: {
    '01': '> S$16M',
    '02': '> S$5M to S$50M',
    '03': 'Up to S$16M',
    '04': 'Up to S$5M',
  },
  QS: {
    '01': '> S$16M',
    '02': '> S$5M to S$50M',
    '03': 'Up to S$16M',
    '04': 'Up to S$5M',
  },
  PM: {
    '01': '> S$50M',
    '02': '> S$16M to S$105M',
    '03': 'Up to S$50M',
    '04': 'Up to S$16M',
  },
};

function cleanCompanyName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toUpperCase()
    .replace(/\./g, ' ')
    .replace(/,/g, ' ')
    .replace(/\(SINGAPORE\)/g, ' SINGAPORE ')
    .replace(/\b(PTE\s*LTD|PVT\s*LTD|PRIVATE\s*LIMITED|PTY\s*LTD)\b/g, ' ')
    .replace(/\b(PTE|LTD|LIMITED|PRIVATE|LLP|LLC|SDN|BHD|CORP|INC)\b/g, ' ')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesFirm(query, firm) {
  if (!query || !firm) return false;
  const qRaw = query.trim().toUpperCase();
  const uin = (firm.uin || '').trim().toUpperCase();
  if (qRaw && qRaw === uin) return true;

  const fName = firm.companyName || '';
  const qClean = cleanCompanyName(query);
  const fClean = cleanCompanyName(fName);

  if (!qClean || !fClean) return false;
  if (qClean === fClean) return true;

  if (qClean.length >= 4) {
    const qRegex = new RegExp(`(?:^|\\s)${escapeRegex(qClean)}(?:$|\\s)`);
    if (qRegex.test(fClean)) return true;
    const fRegex = new RegExp(`(?:^|\\s)${escapeRegex(fClean)}(?:$|\\s)`);
    if (fRegex.test(qClean)) return true;
  }

  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pageUrl = 'https://pspc.bca.gov.sg/#/pspc/listing/default';
  const apiUrl = 'https://pspc.bca.gov.sg/WebService/api/pspc/listPSPCListing';

  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: '',
    };
  }

  const queryDate = new Date().toISOString().slice(0, 10);
  const token = Date.now().toString().split('').reverse().join('');

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Activate-Token': token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://pspc.bca.gov.sg',
        'Referer': pageUrl,
      },
      body: JSON.stringify({
        queryDate,
        discipline: '',
        panel: '',
        startIndex: '',
        count: '',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 403 || res.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    if (!json || typeof json !== 'object' || !Array.isArray(json.pspcListingDataList)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    const list = json.pspcListingDataList;
    if (list.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    const matched = [];
    for (const firm of list) {
      if (matchesFirm(keyword, firm)) {
        const code = (firm.listingCode || '').trim().toUpperCase();
        const discCode = code.slice(0, 2);
        const panelNum = code.slice(2);
        const discipline = DISCIPLINE_MAP[discCode] || discCode;
        const panel = panelNum ? `Panel ${parseInt(panelNum, 10)}` : '';
        const tendering_limit = (LIMIT_MAP[discCode] && LIMIT_MAP[discCode][panelNum]) || '';

        matched.push({
          name: (firm.companyName || '').trim(),
          uen: (firm.uin || '').trim(),
          listing_code: code,
          discipline,
          panel,
          tendering_limit,
        });
      }
    }

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    const excerptItems = matched.map(
      (r) => `[${r.listing_code}] ${r.name} (UEN: ${r.uen}, Discipline: ${r.discipline}, ${r.panel}, Limit: ${r.tendering_limit})`
    );
    const excerpt = excerptItems.join('; ').slice(0, 500);

    return {
      status: 'found',
      reason: '',
      records: matched,
      source_url: pageUrl,
      excerpt,
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 23;
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'http_error',
      records: [],
      source_url: pageUrl,
      excerpt: '',
    };
  }
}
