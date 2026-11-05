export const meta = {
  task: 'SG-singaporefintech.org',
  want: 'w1',
  tier: 2,
  method: 'get',
  input: 'company name',
  fields: ['name', 'category'],
  canary: {
    found: 'Wesurance Pte. Limited',
    not_found: 'Space Factor',
  },
};

const CATEGORY_MAP = {
  'aml-ekyc-regtech': 'AML/eKYC/Regtech',
  'artificial-intelligence-ai': 'Artificial Intelligence (AI)',
  'blockchain-related': 'Blockchain Related',
  'cybersecurity': 'Cybersecurity',
  'investment-tech': 'Investment Tech',
  'insurtech': 'InsurTech',
  'consumer-finance': 'Consumer Finance',
  'lending-and-corporate-cards': 'Lending and Corporate Cards',
  'wealthtech-and-payments': 'WealthTech and Payments',
  'robo-advisory-and-credit-scoring': 'Robo-Advisory and Credit Scoring',
  others: 'Others',
  'manpower-supporting-workforce': 'Manpower & Supporting Workforce',
  'business-cost-managing-cash-flow': 'Business Cost & Managing Cash Flow',
  'sustaining-investments': 'Sustaining Investments',
  'bolstering-sales': 'Bolstering Sales',
  'training-grants': 'Training Grants',
};

let lastRequestTime = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeFetch(url) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1050) {
    await sleep(1050 - elapsed);
  }
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function normalize(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/&#038;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/\b(pte\.?|ltd\.?|private|limited|llc|inc\.?|corp\.?|corporation)\b/gi, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(query, candidate) {
  const qNorm = normalize(query);
  const cNorm = normalize(candidate);
  if (!qNorm || !cNorm) return false;
  if (qNorm === cNorm) return true;

  const qNoSg = qNorm.replace(/\bsingapore\b/g, '').replace(/\s+/g, ' ').trim();
  const cNoSg = cNorm.replace(/\bsingapore\b/g, '').replace(/\s+/g, ' ').trim();
  if (qNoSg && cNoSg && qNoSg === cNoSg) return true;

  const qWords = qNorm.split(' ').filter(Boolean);
  const cWords = cNorm.split(' ').filter(Boolean);
  if (qWords.length >= 2 && cWords.length >= 2) {
    if (qWords.every((w) => cWords.includes(w)) || cWords.every((w) => qWords.includes(w))) {
      return true;
    }
  }

  return false;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://singaporefintech.org/?s=&post_type=tr_m2mdirectory',
        excerpt: '',
      };
    }

    const trimmed = keyword.trim();
    const searchUrl = `https://singaporefintech.org/?s=${encodeURIComponent(trimmed)}&post_type=tr_m2mdirectory`;

    let res;
    try {
      res = await politeFetch(searchUrl);
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || /timeout/i.test(String(err));
      return {
        status: 'couldnt_check',
        reason: isTimeout ? 'timeout' : 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: String(err).slice(0, 500),
      };
    }

    if (res.status === 403 || res.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP ${res.status} response from server`,
      };
    }

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: `HTTP ${res.status} on ${searchUrl}`,
      };
    }

    const html = await res.text();

    if (/challenge-running|cf-turnstile|cf-challenge|<title>Just a moment/i.test(html)) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: searchUrl,
        excerpt: 'Bot challenge detected on page',
      };
    }

    const hasSearchForm = html.includes('name="s"') || html.includes('id="s"');
    const hasResultsIndicator = /Results\s+For/i.test(html) || html.includes('main-footer');
    if (!hasSearchForm && !hasResultsIndicator) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: 'Expected search layout markers not found',
      };
    }

    // Extract directory search result links
    const cardRegex =
      /<a class="[^"]*text-bold[^"]*" href="(https:\/\/singaporefintech\.org\/m2mdirectory\/[^"]+)">([\s\S]*?)<\/a>/gi;
    const candidates = [];
    let match;
    while ((match = cardRegex.exec(html)) !== null) {
      const url = match[1];
      if (url.includes('/feed')) continue;
      const title = match[2]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#8211;/g, '-')
        .replace(/&#038;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      candidates.push({ url, title });
    }

    const matchingCandidates = candidates.filter((c) => matches(trimmed, c.title));

    if (matchingCandidates.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    const records = [];
    let firstSourceUrl = '';
    let firstExcerpt = '';

    for (const cand of matchingCandidates) {
      let detailRes;
      try {
        detailRes = await politeFetch(cand.url);
      } catch (err) {
        const isTimeout = err.name === 'AbortError' || /timeout/i.test(String(err));
        return {
          status: 'couldnt_check',
          reason: isTimeout ? 'timeout' : 'http_error',
          records: [],
          source_url: cand.url,
          excerpt: String(err).slice(0, 500),
        };
      }

      if (detailRes.status === 403 || detailRes.status === 429) {
        return {
          status: 'couldnt_check',
          reason: 'blocked',
          records: [],
          source_url: cand.url,
          excerpt: `HTTP ${detailRes.status} response from server`,
        };
      }

      if (!detailRes.ok) {
        return {
          status: 'couldnt_check',
          reason: 'http_error',
          records: [],
          source_url: cand.url,
          excerpt: `HTTP ${detailRes.status} on ${cand.url}`,
        };
      }

      const detailHtml = await detailRes.text();

      if (/challenge-running|cf-turnstile|cf-challenge|<title>Just a moment/i.test(detailHtml)) {
        return {
          status: 'couldnt_check',
          reason: 'blocked',
          records: [],
          source_url: cand.url,
          excerpt: 'Bot challenge detected on page',
        };
      }

      const artMatch = detailHtml.match(/<article[^>]+class="([^"]+)"[^>]*>([\s\S]*?)<\/article>/i);
      if (!artMatch) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: cand.url,
          excerpt: 'Article element not found on detail page',
        };
      }

      const classAttr = artMatch[1];
      const catMatches = classAttr.match(/m2mdirectory_cat-([a-zA-Z0-9\-_]+)/g) || [];
      const categories = catMatches.map((c) => {
        const slug = c.replace('m2mdirectory_cat-', '');
        return CATEGORY_MAP[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      });
      const category = categories.length > 0 ? categories.join(', ') : 'FinTech';

      const titleMatch = artMatch[2].match(/<h1 class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i);
      const name = titleMatch
        ? titleMatch[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&#8211;/g, '-')
            .replace(/&#038;/g, '&')
            .replace(/&nbsp;/g, ' ')
            .trim()
        : cand.title;

      const dateMatch = artMatch[2].match(/class="entry-date[^"]*"[^>]*datetime="([^"]+)"/i);
      const postDate = dateMatch ? dateMatch[1].slice(0, 10) : '';

      records.push({
        name,
        category,
      });

      if (!firstSourceUrl) {
        firstSourceUrl = cand.url;
        firstExcerpt = `${name} | Category: ${category}${postDate ? ' | Posted: ' + postDate : ''} | Singapore FinTech Association member directory`;
      }
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstSourceUrl || searchUrl,
      excerpt: firstExcerpt.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://singaporefintech.org/?s=&post_type=tr_m2mdirectory',
      excerpt: String(err).slice(0, 500),
    };
  }
}
