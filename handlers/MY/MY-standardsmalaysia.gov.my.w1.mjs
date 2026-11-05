export const meta = {
  task: 'MY-standardsmalaysia.gov.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'address', 'fax', 'website', 'scope_url'],
  canary: {
    found: 'INTERTEK CERTIFICATION INTERNATIONAL SDN. BHD.',
    not_found: 'O2O Digital',
  },
};

function decodeHtml(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanText(str) {
  return decodeHtml(str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRecords(html) {
  const records = [];
  const rowRegex = /<tr>\s*<td>(\d+)<\/td>\s*<td class="table-plus">([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const orgHtml = match[2];
    const actionHtml = match[3];

    // Extract name from leading strong tags (excluding Fax No and Web)
    const strongs = [...orgHtml.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)]
      .map(m => cleanText(m[1]))
      .filter(s => s && !/^fax\s*no/i.test(s) && !/^web/i.test(s));
    const name = strongs.join(' ');

    // Extract Fax
    const faxMatch = orgHtml.match(/Fax No:\s*<\/strong>\s*([^&<\n\r]+)/i);
    const fax = faxMatch ? cleanText(faxMatch[1]) : '';

    // Extract Website
    const webMatch = orgHtml.match(/<a\s+[^>]*href=["\x27]([^"\x27]+)["\x27][^>]*>/i);
    const website = webMatch ? webMatch[1].trim() : '';

    // Extract Scope URL
    const scopeMatch = actionHtml.match(/window\.location\.href=["\x27]([^"\x27]+)["\x27]/i);
    const scope_url = scopeMatch ? new URL(scopeMatch[1], 'https://cab.jsm.gov.my/cab-directories/').href : '';

    // Address is between name and Fax No / Web
    let body = orgHtml;
    const faxIdx = body.search(/<strong>\s*Fax No:/i);
    if (faxIdx !== -1) body = body.slice(0, faxIdx);
    const webIdx = body.search(/<strong>\s*Web:/i);
    if (webIdx !== -1) body = body.slice(0, webIdx);

    body = body.replace(/<strong>[\s\S]*?<\/strong>/gi, '');

    const address = decodeHtml(body)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map(l => l.trim().replace(/^,+|,+$/g, '').trim())
      .filter(Boolean)
      .join(', ');

    if (name) {
      records.push({
        name,
        address,
        fax,
        website,
        scope_url,
      });
    }
  }

  return records;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = 'https://cab.jsm.gov.my/cab-directories/result';

  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: '',
    };
  }

  const trimmedKw = keyword.trim();

  try {
    const params = new URLSearchParams({ nameScheme: trimmedKw });
    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://cab.jsm.gov.my/cab-directories/',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 403 || res.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    const html = await res.text();

    // Check layout marker: the page must be from the CAB directory
    if (!html.includes('Accredited Organisations') && !html.includes('Department of Standards Malaysia')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: cleanText(html).slice(0, 500),
      };
    }

    // Check if not found
    if (html.includes('Sorry, there are no results were found') || html.includes('alert-warning')) {
      const alertMatch = html.match(/<div[^>]*class=["\x27][^"\x27]*alert-warning[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i);
      const excerpt = alertMatch ? cleanText(alertMatch[1]).slice(0, 500) : 'No results found';
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt,
      };
    }

    // Check if results found
    const countMatch = html.match(/Found\s*:\s*<strong>(\d+)<\/strong>\s*Record/i);
    if (countMatch || html.includes('alert-primary')) {
      const records = parseRecords(html);
      if (records.length === 0) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: searchUrl,
          excerpt: cleanText(html).slice(0, 500),
        };
      }

      const alertMatch = html.match(/<div[^>]*class=["\x27][^"\x27]*alert-primary[^"\x27]*["\x27][^>]*>([\s\S]*?)<\/div>/i);
      let excerpt = alertMatch ? cleanText(alertMatch[1]) : '';
      if (records[0]) {
        excerpt = `${excerpt} | ${records[0].name} | ${records[0].address}`.trim();
      }

      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: excerpt.slice(0, 500),
      };
    }

    // If neither result condition matched
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: searchUrl,
      excerpt: cleanText(html).slice(0, 500),
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        status: 'couldnt_check',
        reason: 'timeout',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'http_error',
      records: [],
      source_url: searchUrl,
      excerpt: '',
    };
  }
}
