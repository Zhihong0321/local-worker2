export const meta = {
  task: 'GB-smmt.co.uk',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listing_url'],
  canary: { found: 'Jaguar Land Rover Limited', not_found: 'Zyxwvu Qlorbex Industries Limited' },
};

const LIST_URL = 'https://www.smmt.co.uk/smmt-members/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// The list is server-rendered; fewer than this many entries means the page is not the full list.
const MIN_LIST_SIZE = 100;
// Trailing legal-form words ignored when comparing names.
const LEGAL = new Set(['limited', 'ltd', 'plc', 'llp', 'llc', 'inc', 'gmbh', 'co', 'corp', 'corporation', 'ag', 'bv', 'sa',
  'sas', 'sarl', 'srl', 'oy', 'ab', 'as', 'nv', 'spa']);
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '-', mdash: '-', lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', eacute: 'e', egrave: 'e', ouml: 'o', uuml: 'u', auml: 'a', ccedil: 'c' };

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

function cleanText(s) {
  return decodeEntities((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalise(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Comparison key: normalised words, without a leading "the" or trailing legal form. */
function core(s) {
  const words = normalise(s).split(' ').filter(Boolean);
  if (words[0] === 'the') words.shift();
  while (words.length && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Parse the member entries: each is a link whose <h5 class="post-list__title"> holds the company name.
 *  Entries whose name text is blank stay in the list (name ''), so the completeness check still counts them. */
function parseMembers(html) {
  const headings = (html.match(/<h5\b[^>]*\bpost-list__title\b/g) || []).length;
  const re = /<a\s+href="([^"]*)"[^>]*>\s*<span>\s*<div>\s*<h5\b[^>]*\bpost-list__title\b[^>]*>([\s\S]*?)<\/h5>/g;
  const members = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = decodeEntities(m[1]).trim();
    const listingUrl = href ? new URL(href, LIST_URL).href : '';
    members.push({ name: cleanText(m[2]), listing_url: listingUrl });
  }
  return { headings, members };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = core(keyword);
    if (!query) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|access denied/i.test(html.slice(0, 5000)) && !/post-list__title/.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: html.slice(0, 200) };
    }
    if (!html.includes('post-type-archive-member') && !html.includes('post-list__title')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }

    const { headings, members } = parseMembers(html);
    // Every heading must parse into an entry, and the list must be full-sized; otherwise a missing name
    // could look like "not listed".
    if (headings < MIN_LIST_SIZE || members.length !== headings) {
      return {
        status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL,
        excerpt: `parsed ${members.length} of ${headings} member headings`,
      };
    }

    const seen = new Set();
    const records = [];
    for (const mem of members) {
      if (!mem.name || core(mem.name) !== query) continue;
      const key = `${mem.name}|${mem.listing_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ name: mem.name, listing_url: mem.listing_url });
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `No match among ${members.length} listed SMMT members`,
      };
    }

    return {
      status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: `SMMT members list: ${records.map((r) => r.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
