export const meta = {
  task: 'MY-watermarks.com.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['certificate_holder', 'certificate_number', 'country', 'product_name', 'product_standard', 'status'],
  canary: { found: 'SORENTO SDN BHD', not_found: 'O2O Digital' },
};

function normalizeName(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCorpSuffix(str) {
  return str
    .replace(/\b(sdn|bhd|berhad|limited|ltd|m|malaysia)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHolderMatch(holder, keyword) {
  const normHolder = normalizeName(holder);
  const normKw = normalizeName(keyword);
  if (!normHolder || !normKw) return false;
  if (normHolder === normKw) return true;

  const cHolder = stripCorpSuffix(normHolder);
  const cKw = stripCorpSuffix(normKw);
  if (cHolder && cKw) {
    if (cHolder === cKw) return true;
    if (cHolder.startsWith(cKw) || cKw.startsWith(cHolder)) return true;
  }
  return false;
}

async function fetchFromApi(term) {
  const url = `https://wcs.watermarks.com.my/api/certifiedProducts/GetAll?keyword=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://watermarks.com.my/',
    },
    signal: AbortSignal.timeout(15000),
  });
  return { res, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pageUrl = 'https://watermarks.com.my/certified-products/overall-products/';

  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: pageUrl,
      excerpt: '',
    };
  }

  const trimmedKw = keyword.trim();

  try {
    let apiData = null;
    let lastUrl = pageUrl;

    // First attempt: search with raw trimmed keyword
    try {
      const { res, url } = await fetchFromApi(trimmedKw);
      lastUrl = url;

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
      try {
        apiData = JSON.parse(text);
      } catch {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: pageUrl,
          excerpt: '',
        };
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return {
          status: 'couldnt_check',
          reason: 'timeout',
          records: [],
          source_url: pageUrl,
          excerpt: '',
        };
      }
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    // Verify response schema for layout check
    if (!apiData || apiData.success !== true || !apiData.result || !Array.isArray(apiData.result.items)) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    let items = apiData.result.items;

    // If 0 items and keyword has punctuation / company suffixes, try fallback with core name
    if (items.length === 0) {
      const core = stripCorpSuffix(normalizeName(trimmedKw));
      if (core && core !== normalizeName(trimmedKw) && core.length >= 2) {
        // Polite delay before secondary request
        await new Promise(r => setTimeout(r, 1000));

        try {
          const { res, url } = await fetchFromApi(core);
          lastUrl = url;
          if (res.ok) {
            const text = await res.text();
            const fallbackData = JSON.parse(text);
            if (fallbackData && fallbackData.success && fallbackData.result && Array.isArray(fallbackData.result.items)) {
              items = fallbackData.result.items;
            }
          }
        } catch {
          // If fallback fails, keep items as []
        }
      }
    }

    // Filter items to ensure holder matches searched company
    const matched = items.filter(it => isHolderMatch(it.certificateHolder, trimmedKw));

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: '',
      };
    }

    const records = matched.map(it => ({
      certificate_holder: (it.certificateHolder || '').trim(),
      certificate_number: (it.certificateNumber || '').trim(),
      country: (it.country || '').trim(),
      product_name: (it.productName || '').trim(),
      product_standard: (it.productStandard || '').trim(),
      status: (it.status || '').trim(),
    }));

    const excerpt = JSON.stringify(records[0]).slice(0, 500);

    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: pageUrl,
      excerpt: '',
    };
  }
}
