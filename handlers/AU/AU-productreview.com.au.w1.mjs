export const meta = { task: 'AU-productreview.com.au', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'full_name', 'brand', 'categories', 'url', 'website', 'short_description', 'listing_type'],
  canary: { found: 'Commonwealth Bank', not_found: 'Zyxqorvel Holdings Pty Ltd' } };

const SITE = 'https://www.productreview.com.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped before comparing names (AU companies: Pty Ltd, Limited, Proprietary, ...).
const LEGAL = new Set(['pty', 'ltd', 'limited', 'proprietary', 'inc', 'incorporated', 'llc', 'plc', 'corp', 'corporation', 'co', 'company']);

/** Lower-case, drop accents, "&" = "and", keep letters and digits in any script, drop legal-form words. */
function tokens(str) {
  return (str || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL.has(t));
}

function normalizeName(str) {
  return tokens(str).join('');
}

/** The search text: the name without its trailing legal form, as the user typed it. */
function searchText(keyword) {
  const parts = keyword.trim().split(/\s+/);
  while (parts.length > 1 && tokens(parts[parts.length - 1]).length === 0) parts.pop();
  return parts.join(' ');
}

/** The results page embeds its data as JSON inside a script tag (Redux state). */
function extractState(html) {
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = m[1];
    if (body.includes('reduxAsyncConnect') && body.trimStart().startsWith('{')) {
      return JSON.parse(body);
    }
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const input = String(keyword || '').trim();
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty company name' };
    }
    const query = searchText(input);
    searchUrl = `${SITE}/search?q=${encodeURIComponent(query)}`;

    const res = await fetch(searchUrl, {
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    let state = null;
    try {
      state = extractState(html);
    } catch (e) {
      state = null;
    }
    const container = state?.reduxAsyncConnect?.itemsMap?.searchAsyncDataContainer;
    const searchResponse = container?.data?.searchResponse;
    if (!searchResponse || !Array.isArray(searchResponse.hits?.hits)) {
      // No results data: a bot check is "blocked", anything else is a page we do not understand.
      const challenge = /<title>\s*Just a moment|cf-chl|captcha|Access denied/i.test(html.slice(0, 20000));
      return {
        status: 'couldnt_check',
        reason: challenge ? 'blocked' : 'layout_changed',
        records: [],
        source_url: searchUrl,
        excerpt: challenge ? 'bot check page' : html.slice(0, 300),
      };
    }

    const wanted = normalizeName(input);
    const hits = searchResponse.hits.hits;
    const records = [];
    for (const hit of hits) {
      const src = hit?._source || {};
      if (!src.slug) continue;
      const names = [src.name, src.fullName, src.shortName].filter(Boolean);
      const isMatch = wanted && names.some((n) => normalizeName(n) === wanted);
      if (!isMatch) continue;
      records.push({
        name: src.name || '',
        full_name: src.fullName || '',
        brand: src.brand?.name || '',
        categories: Array.isArray(src.categoryNames) ? src.categoryNames : [],
        url: `${SITE}/listings/${src.slug}`,
        website: src.brand?.url || '',
        short_description: src.shortDescription || '',
        listing_type: src.type || '',
      });
    }

    if (records.length === 0) {
      const total = searchResponse.hits.total?.value ?? searchResponse.hits.total ?? hits.length;
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Search "${query}" answered with ${total} results; none is named "${input}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: records.map((r) => `${r.name} | ${r.categories.join(' > ')} | ${r.short_description}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl || SITE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
