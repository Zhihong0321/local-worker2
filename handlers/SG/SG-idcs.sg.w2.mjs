export const meta = {
  task: 'SG-idcs.sg',
  want: 'w2',
  tier: 1,
  method: 'static_list',
  input: 'designer or interior design firm name',
  fields: ['name', 'firm', 'profile_url'],
  canary: {
    found: 'A.RK interior Design Pte Ltd',
    not_found: 'Space Factor',
  },
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one designer or firm up in IDCS public members listing. */
export default async function lookup(keyword) {
  const normKw = normalize(keyword);
  const sourceUrl = 'https://idcs.sg/members/listing';

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
    if (!html.includes('Members Listing') && !html.includes('idcs.sg')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: sourceUrl,
        excerpt: '',
      };
    }

    const matches = [];
    let firstExcerpt = '';

    const itemRegex = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*member-list-item[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(itemRegex)) {
      const profileUrl = m[1];
      const block = m[2];

      const nameMatch = block.match(/<b>([\s\S]*?)<\/b>/i);
      const name = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      // The rest of the text in member-list-data is the firm name
      const dataBlock = block.match(/<div class="member-list-data[^"]*">([\s\S]*?)<\/div>/i)?.[1] || '';
      const firmText = dataBlock.replace(/<b>[\s\S]*?<\/b>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      const normName = normalize(name);
      const normFirm = normalize(firmText);

      if (
        (normName && (normName.includes(normKw) || normKw.includes(normName))) ||
        (normFirm && (normFirm.includes(normKw) || normKw.includes(normFirm)))
      ) {
        matches.push({
          name,
          firm: firmText,
          profile_url: profileUrl,
        });
        if (!firstExcerpt) {
          firstExcerpt = `${name} - ${firmText} (${profileUrl})`;
        }
      }
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: sourceUrl,
        excerpt: firstExcerpt.slice(0, 500),
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
