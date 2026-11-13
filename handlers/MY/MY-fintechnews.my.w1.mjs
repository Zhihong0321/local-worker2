export const meta = { task: 'MY-fintechnews.my', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'url', 'category', 'founded_in', 'website', 'description'],
  canary: { found: '2C2P', not_found: 'Kedai Runcit Bersatu Sdn Bhd' } };

// Fintech News Malaysia publishes a WordPress directory of Malaysian fintech companies (328 entries, 30 per listing
// page). The site search does not reliably return directory entries, and the directory sitemap leaves some listed
// companies out, so this handler reads every listing page and compares normalised names.

const SITE = 'https://fintechnews.my';
const LIST_URL = `${SITE}/list-fintech-startup-malaysia-fintech-companies-malaysia-directory/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL = new Set(['sdn', 'bhd', 'berhad', 'plt', 'llp', 'ltd', 'limited', 'pte', 'llc', 'inc']);
const MAX_PAGES = 40;
const BATCH = 4;
const BUDGET_MS = 45000;
const BOT_WALL = /challenge-platform|cf-chl|just a moment|captcha-delivery|verify you are human/i;

class Stop extends Error {
  constructor(reason, url, excerpt) {
    super(excerpt);
    this.reason = reason;
    this.url = url;
    this.excerpt = excerpt;
  }
}

function codePoint(n) {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function text(html) {
  return decode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : '';
}

/** Normalised name: parentheses dropped, legal form dropped, case and punctuation ignored. */
function coreKey(s) {
  return decode(s)
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL.has(t))
    .join('');
}

/** Listing entries on one page: the permalink anchor of every my_fintechs_dir_ltg entry. */
function parseEntries(html) {
  const seen = new Map();
  for (const tag of html.match(/<a\b[^>]*drts-entity-permalink[^>]*>/gi) || []) {
    if (!/data-content-name="my_fintechs_dir_ltg"/.test(tag)) continue;
    const href = attr(tag, 'href');
    const title = attr(tag, 'title').replace(/\s+/g, ' ').trim();
    if (!href || !title) continue;
    const url = new URL(href, SITE).href;
    if (!seen.has(url)) seen.set(url, { url, title });
  }
  return [...seen.values()];
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, body: await res.text() };
}

async function getOrStop(url) {
  let r;
  try {
    r = await get(url);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Stop(timeout ? 'timeout' : 'other', url, `request failed: ${String(e && e.message || e).slice(0, 200)}`);
  }
  if (r.status === 403 || r.status === 429) throw new Stop('blocked', url, `HTTP ${r.status}`);
  if (r.status !== 200) throw new Stop('http_error', url, `HTTP ${r.status}`);
  return r.body;
}

async function listingPage(n) {
  const url = n === 1 ? LIST_URL : `${LIST_URL}?_page=${n}&num=30&sort=`;
  const html = await getOrStop(url);
  const entries = parseEntries(html);
  if (!entries.length) {
    if (BOT_WALL.test(html)) throw new Stop('blocked', url, 'bot check page instead of the directory');
    throw new Stop('layout_changed', url, 'no directory entries on page: ' + text(html).slice(0, 200));
  }
  return { entries, html };
}

/** The HTML inside a <div> whose opening tag ends just before `from`, found by balancing nested divs. */
function innerOfDiv(html, from) {
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return html.slice(from, m.index);
    } else {
      depth++;
    }
  }
  return html.slice(from, from + 4000);
}

/** Company page fields: category, founded year, website, description. */
function detailFields(html) {
  const field = (name) => {
    const at = html.indexOf(`data-name="${name}"`);
    if (at < 0) return '';
    const from = html.indexOf('>', at) + 1; // just after this element's opening tag
    const block = innerOfDiv(html, from).replace(/<div class="drts-entity-field-label[\s\S]*?<\/div>/i, '');
    return text(block).slice(0, 1000);
  };
  return {
    category: field('entity_field_directory_category'),
    founded_in: field('entity_field_field_founded_in'),
    website: field('entity_field_field_website'),
    description: field('entity_field_post_content'),
  };
}

async function enrich(m) {
  const rec = { name: m.title, url: m.url, category: '', founded_in: '', website: '', description: '' };
  try {
    const html = await getOrStop(m.url);
    if (!/post-title/i.test(html)) throw new Stop('layout_changed', m.url, 'company page has no title');
    Object.assign(rec, detailFields(html));
  } catch (e) {
    rec.detail_note = e instanceof Stop ? `${e.reason}: ${e.excerpt}` : `other: ${String(e).slice(0, 200)}`;
  }
  return rec;
}

function out(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const key = coreKey(keyword);
    if (!key) return out('couldnt_check', 'other', LIST_URL, 'no usable company name in the input');

    const first = await listingPage(1);
    const pageNums = [...first.html.matchAll(/[?&]_page=(\d+)/g)].map((m) => Number(m[1]));
    const lastPage = Math.max(1, ...pageNums);
    if (lastPage > MAX_PAGES) {
      return out('couldnt_check', 'other', LIST_URL, `directory has ${lastPage} listing pages; handler reads up to ${MAX_PAGES}`);
    }

    const pages = [first.entries];
    const problems = [];
    const rest = [];
    for (let n = 2; n <= lastPage; n++) rest.push(n);
    for (let i = 0; i < rest.length; i += BATCH) {
      if (Date.now() - started > BUDGET_MS) {
        problems.push(new Stop('timeout', LIST_URL, `ran out of time before listing page ${rest[i]}`));
        break;
      }
      const group = rest.slice(i, i + BATCH);
      const results = await Promise.all(group.map((n) => listingPage(n).then((p) => p, (e) => e)));
      results.forEach((r, j) => {
        if (r instanceof Stop) problems.push(r);
        else if (r instanceof Error) problems.push(new Stop('other', LIST_URL, `listing page ${group[j]}: ${r.message}`));
        else pages.push(r.entries);
      });
    }

    const all = new Map();
    for (const e of pages.flat()) all.set(e.url, e);
    const entries = [...all.values()];
    const matches = entries.filter((e) => coreKey(e.title) === key);

    if (matches.length) {
      const records = [];
      for (const m of matches.slice(0, 5)) records.push(await enrich(m));
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: first.url,
        excerpt: `Listed as "${first.name}"${first.category ? ` (${first.category})` : ''}`.slice(0, 500),
      };
    }

    if (problems.length) {
      const p = problems[0];
      return out('couldnt_check', p.reason, p.url, `${p.excerpt}; no match on the ${pages.length} listing pages read`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt: `No entry named "${keyword}" among ${entries.length} directory entries on ${lastPage} listing pages`,
    };
  } catch (e) {
    if (e instanceof Stop) return out('couldnt_check', e.reason, e.url, e.excerpt);
    return out('couldnt_check', 'other', LIST_URL, String(e && e.message || e));
  }
}
