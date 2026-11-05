export const meta = {
  task: 'SG-customs.gov.sg',
  want: 'w2',
  tier: 1,
  method: 'static_list',
  input: 'trader or company name',
  fields: ['title', 'date', 'url'],
  canary: {
    found: 'Apex Logistics Pte Ltd',
    not_found: 'Makoto-Ya Singapore',
  },
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company or trader up in Singapore Customs news and media releases. */
export default async function lookup(keyword) {
  const normKw = normalize(keyword);
  const sourceUrl = 'https://www.customs.gov.sg/news/';

  if (!normKw) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: '',
    };
  }

  try {
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
    if (!html.includes('customs.gov.sg') && !html.includes('Singapore Customs')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const itemRegex = /\{"id":"([^"]+)","date":"([^"]+)"[\s\S]*?"title":"([^"]+)"[\s\S]*?"referenceLinkHref":"([^"]+)"[\s\S]*?"formattedDate":"([^"]+)"/g;

    const matches = [];
    let firstExcerpt = '';

    for (const m of unescaped.matchAll(itemRegex)) {
      const title = m[3];
      const itemUrl = m[4];
      const date = m[5];
      const normTitle = normalize(title);

      if (normTitle && (normTitle.includes(normKw) || normKw.includes(normTitle))) {
        matches.push({
          title,
          date,
          url: itemUrl,
        });
        if (!firstExcerpt) {
          firstExcerpt = `${date}: ${title} (${itemUrl})`.slice(0, 500);
        }
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: firstExcerpt,
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
