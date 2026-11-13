export const meta = { task: 'AU-bca.com.au', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'website'], canary: { found: 'BHP', not_found: 'Zebra Kangaroo Pottery Pty Ltd' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE = 'https://www.bca.com.au/membership/';

// Legal-form and filler words ignored when comparing names (case, punctuation and these words do not count).
const IGNORE = new Set(['pty', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'plc', 'corp', 'corporation', 'co', 'company', 'the']);

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !IGNORE.has(t))
    .join(' ');
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = `${PAGE}#member-directory`;
  try {
    const wanted = normalize(keyword);
    if (!wanted) return fail('other', sourceUrl, 'no Latin letters in the name to compare with the English member list');

    // The member directory is in the static membership page: one <a class="card"> per member, name in an <h3>.
    const res = await fetch(PAGE, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', PAGE, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', PAGE, `HTTP ${res.status}`);
    const html = await res.text();

    // Only the member grid (id="postsWrapper" up to the end of its section), not other cards on the page.
    const start = html.indexOf('id="postsWrapper"');
    if (start < 0) return fail('layout_changed', PAGE, 'member grid (postsWrapper) not found');
    const endAt = html.indexOf('</section>', start);
    const grid = html.slice(start, endAt > start ? endAt : undefined);

    const members = [...grid.matchAll(/<a href="([^"]+)" class="card[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g)]
      .map((m) => ({ name: decodeEntities(m[2]), website: m[1].trim() }))
      .filter((m) => m.name);
    if (members.length === 0) return fail('layout_changed', PAGE, 'member grid has no member cards');

    // Match the company, not similar words: the normalised names must be the same.
    const records = members.filter((m) => normalize(m.name) === wanted);
    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `BCA member directory lists ${members.length} members; no member named "${String(keyword).slice(0, 80)}"`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: `BCA member directory: ${records.map((r) => r.name).join('; ')} (of ${members.length} members listed)`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', sourceUrl, String(err?.message || err));
  }
}
