export const meta = {
  task: 'GB-reviews.io',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'reviews_io_url', 'website', 'review_count', 'average_score', 'description'],
  canary: { found: 'Marks And Spencer', not_found: 'Zorvexan Widgets Limited' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.reviews.io/company-reviews/store/';
const LEGAL = new Set(['ltd', 'limited', 'plc', 'llp', 'cic', 'inc', 'llc']);

/** Lowercase words of a name: '&' becomes 'and', punctuation dropped. */
function words(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalised comparison key: words joined, legal form and leading 'the' removed. */
function nameKey(str) {
  let w = words(str);
  if (w[0] === 'the' && w.length > 1) w = w.slice(1);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w = w.slice(0, -1);
  return w.join('');
}

function cleanText(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slugs the site might use for this name, most likely first. */
function candidateSlugs(keyword) {
  const all = words(keyword);
  let stripped = [...all];
  if (stripped[0] === 'the' && stripped.length > 1) stripped = stripped.slice(1);
  while (stripped.length > 1 && LEGAL.has(stripped[stripped.length - 1])) stripped = stripped.slice(0, -1);
  // At most two slugs: they are fetched one after the other, so the worst case stays under 60 s.
  const out = [stripped.join('-'), all.join('-')];
  return [...new Set(out.filter(Boolean))].slice(0, 2);
}

/** Read the merchant name, website, rating and description from a store page. */
function parseStore(html) {
  let name = '';
  let ld = null;
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      const j = JSON.parse(ldMatch[1]);
      if (j && typeof j.name === 'string') {
        name = j.name.trim();
        ld = j;
      }
    } catch (e) {
      // fall through to the heading
    }
  }
  if (!name) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) name = cleanText(h1[1]).replace(/\s+Reviews$/i, '').trim();
  }
  const og = html.match(/<meta property="og:title" content="([^"]*)"/i);
  const website = og ? ((og[1].match(/\|\s*([^|]+?)\s*$/) || [])[1] || '') : '';
  const desc = html.match(/<meta name="description" content="([^"]*)"/i);
  const agg = ld && ld.aggregateRating ? ld.aggregateRating : {};
  return {
    name,
    website: website.trim(),
    review_count: agg.reviewCount != null ? String(agg.reviewCount) : '',
    average_score: agg.ratingValue != null ? String(agg.ratingValue) : '',
    description: desc ? cleanText(desc[1]) : '',
  };
}

/** Fetch one candidate slug and classify the answer. Never throws. */
async function checkSlug(slug, keyword) {
  const url = BASE + encodeURIComponent(slug);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { kind: 'error', reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
    }
    if (res.status === 404) {
      return { kind: 'missing', url, excerpt: 'HTTP 404 Page Not Found' };
    }
    if (!res.ok) {
      return { kind: 'error', reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (/<title>\s*Page Not Found\s*<\/title>/i.test(html)) {
      return { kind: 'missing', url, excerpt: 'Page Not Found' };
    }
    const store = parseStore(html);
    if (!store.name) {
      return { kind: 'error', reason: 'layout_changed', url, excerpt: cleanText(html).slice(0, 300) };
    }
    if (nameKey(store.name) !== nameKey(keyword)) {
      return { kind: 'other_store', url, store, excerpt: `store page for '${slug}' is '${store.name}'` };
    }
    return {
      kind: 'match',
      url: res.url || url,
      slug,
      store,
      excerpt: `${store.name}: ${store.description}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      kind: 'error',
      reason: timedOut ? 'timeout' : 'other',
      url,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause at the end lets the HTTP connections finish closing; without it, on Windows with
 * Node 24, the runner can exit while a socket is still closing and the process aborts (exit 127).
 */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return result;
}

async function lookupOnce(keyword) {
  try {
    const text = String(keyword || '').trim();
    const slugs = candidateSlugs(text);
    if (!text || slugs.length === 0 || !nameKey(text)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }

    // Candidate pages are fetched one after the other (in priority order), stopping at the first match.
    const outcomes = [];
    for (const slug of slugs) {
      const o = await checkSlug(slug, text);
      outcomes.push(o);
      if (o.kind === 'match') break;
    }

    const hit = outcomes.find((o) => o.kind === 'match');
    if (hit) {
      return {
        status: 'found',
        reason: '',
        records: [{
          name: hit.store.name,
          slug: hit.slug,
          reviews_io_url: hit.url,
          website: hit.store.website,
          review_count: hit.store.review_count,
          average_score: hit.store.average_score,
          description: hit.store.description,
        }],
        source_url: hit.url,
        excerpt: hit.excerpt,
      };
    }

    // A refused or broken answer for any candidate means we could not check: never not_found.
    const errors = outcomes.filter((o) => o.kind === 'error');
    if (errors.length > 0) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      errors.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason));
      const e = errors[0];
      return { status: 'couldnt_check', reason: e.reason, records: [], source_url: e.url, excerpt: e.excerpt };
    }

    // Every candidate page answered normally and none is this company.
    const first = outcomes[0];
    const seen = outcomes.filter((o) => o.kind === 'other_store').map((o) => o.excerpt);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: first.url,
      excerpt: seen.length
        ? `No store page for '${text}'. Checked slugs: ${slugs.join(', ')}. ${seen.join('; ')}`
        : `No store page for '${text}' (HTTP 404). Checked slugs: ${slugs.join(', ')}`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
