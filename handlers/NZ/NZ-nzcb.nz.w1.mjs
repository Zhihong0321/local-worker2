export const meta = {
  task: 'NZ-nzcb.nz',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'id', 'slug', 'status', 'modified', 'profile_url'],
  canary: { found: 'Assemble Projects Limited', not_found: 'Te Hanga Whare Kōrero Limited' },
};

const BASE = 'https://www.nzcb.nz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co', 'llc']);

/** Turn HTML entities (named and numeric) into plain characters, dropping any tags. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Normalised company name: lower case, no accents or punctuation, no legal-form words. */
function normName(s) {
  return decodeEntities(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const target = normName(name);
  if (!target) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
  }

  // The site's own search: the business directory REST endpoint (public, no login, no token).
  const searchUrl = `${BASE}/wp-json/wp/v2/businesses?search=${encodeURIComponent(target)}&per_page=100`;

  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let items;
    try {
      items = JSON.parse(text);
    } catch {
      const reason = /captcha|cf-chl|challenge|access denied/i.test(text) ? 'blocked' : 'layout_changed';
      return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    if (!Array.isArray(items)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    const matches = items.filter((it) => it && normName(it.title?.rendered) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Found ${items.length} search result(s) for "${name}", none with this company name`,
      };
    }

    const records = matches.map((it) => ({
      name: decodeEntities(it.title?.rendered).trim(),
      id: it.id ?? null,
      slug: it.slug || '',
      status: it.status || '',
      modified: it.modified || '',
      profile_url: it.link || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url || searchUrl,
      excerpt: `NZCB directory listing: ${records[0].name} (${records[0].profile_url})`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
