export const meta = {
  task: 'GB-ukfinance.org.uk',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'website', 'group'],
  canary: { found: 'Barclays Bank Plc', not_found: 'Zorvex Unlisted Trading Ltd' },
};

// The "Our members" page lists every full member of UK Finance on one page (A-Z, about 350 names).
const LIST_URL = 'https://www.ukfinance.org.uk/membership/our-members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'plc', 'llp', 'lp', 'llc', 'inc', 'corp', 'corporation', 'co', 'company', 'sa', 'ag', 'gmbh', 'bv', 'nv', 'spa', 'srl']);

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Compare names: lower case, "&" as "and", punctuation and spaces removed, trailing legal form dropped.
function normalizeName(str) {
  const words = cleanText(str).toLowerCase().replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

// Walks the page once: each <h2> letter heading sets the group for the <li> items after it.
function parseMembers(html) {
  const entries = [];
  const re = /<h2>([^<]{1,3})<\/h2>|<li[^>]*data-list-item-id="[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let group = '';
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      group = cleanText(m[1]);
      continue;
    }
    const inner = m[2];
    const name = cleanText(inner);
    if (!name) continue;
    const link = inner.match(/<a[^>]*href="(https?:\/\/[^"]+)"/i);
    entries.push({ name, website: link ? decodeEntities(link[1]) : '', group });
  }
  return entries;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows, Node 24 can abort at process exit while a fetch socket is still closing; a short pause avoids it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const kw = typeof keyword === 'string' ? keyword.trim() : '';
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }
    const want = normalizeName(kw);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: `no letters or digits in "${kw}"` };
    }

    const res = await fetch(LIST_URL, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const entries = parseMembers(html);
    if (!/Our members/i.test(html) || entries.length < 100) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: `page has ${entries.length} member entries` };
    }

    const matches = entries.filter((e) => normalizeName(e.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `"${kw}" is not on the UK Finance "Our members" list (${entries.length} members checked; associate members are not checked)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({ name: e.name, website: e.website, group: e.group })),
      source_url: LIST_URL,
      excerpt: `Listed as a UK Finance member: "${matches[0].name}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
