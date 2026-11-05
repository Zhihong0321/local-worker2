export const meta = {
  task: 'SG-asas.org.sg',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company or agency name',
  fields: ['title', 'url', 'summary'],
  canary: {
    found: 'Mediacorp',
    not_found: 'OOm Pte Ltd',
  },
};

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function strip(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company or agency up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const term = (keyword || '').trim();
    if (!term) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://asas.org.sg/News',
        excerpt: '',
      };
    }

    const searchUrl = `https://asas.org.sg/News?search=${encodeURIComponent(term)}&t=1&c=1`;
    const res = await fetch(searchUrl, {
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
        source_url: searchUrl,
        excerpt: '',
      };
    }

    const html = await res.text();
    // Validate page layout
    if (!html.includes('Advertising Standards Authority of Singapore') && !html.includes('asas.org.sg')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    const entries = [...html.matchAll(/<div class="vbEntry[^"]*">([\s\S]*?)<div class="dnnClear">/gi)];
    // Prepare regex for keyword matching (ignoring common suffixes like Pte Ltd if present)
    const cleanTerm = term.replace(/\b(pte|ltd|sdn|bhd|inc|corp|co)\b/gi, '').trim();
    const regex = new RegExp(`\\b${escapeRegExp(cleanTerm || term)}\\b`, 'i');

    const records = [];
    let firstExcerpt = '';

    for (const e of entries) {
      const blockHtml = e[1];
      const titleMatch = blockHtml.match(/<a[^>]*rel="bookmark"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i) ||
                         blockHtml.match(/<a[^>]*href="([^"]*)"[^>]*rel="bookmark"[^>]*>([\s\S]*?)<\/a>/i);
      const bodyMatch = blockHtml.match(/<div class="vbBody[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

      const title = strip(titleMatch ? titleMatch[2] : '');
      const itemUrl = titleMatch ? titleMatch[1] : searchUrl;
      const body = strip(bodyMatch ? bodyMatch[1] : '');

      if (regex.test(title) || regex.test(body)) {
        records.push({
          title,
          url: itemUrl,
          summary: body,
        });
        if (!firstExcerpt) {
          firstExcerpt = `${title}: ${body}`.slice(0, 500);
        }
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: firstExcerpt,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: '',
    };
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'http_error',
      records: [],
      source_url: 'https://asas.org.sg/News',
      excerpt: '',
    };
  }
}
