export const meta = {
  task: 'NZ-worksafe.govt.nz',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_source', 'register', 'url', 'lastmod'],
  canary: { found: 'Ballance Agri-Nutrients Limited', not_found: 'Te Whare Kōrero Limited' },
};

// The site's HTML register pages cannot be read by the worker's built-in fetch (about 30 KB of response headers
// from the site's bot-protection cookies; Node rejects headers over about 16 KB). The sitemap files are small
// and do load. The sitemap index lists the register pages; each register page address carries the company name
// as its slug. A match is a company whose slug equals the normalised name.
const SITEMAP_INDEX = 'https://www.worksafe.govt.nz/sitemap.xml';
const REGISTERS = [
  {
    register: 'Prosecution (court summaries)',
    re: /^https:\/\/www\.worksafe\.govt\.nz\/laws-and-regulations\/prosecutions\/court-summaries\/([a-z0-9-]+)\/$/,
  },
  {
    register: 'Enforceable undertaking (accepted)',
    re: /^https:\/\/www\.worksafe\.govt\.nz\/laws-and-regulations\/enforceable-undertakings\/accepted-enforceable-undertakings\/([a-z0-9-]+)\/$/,
  },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['limited', 'ltd', 'incorporated', 'inc', 'company', 'co']);
const FETCH_CONCURRENCY = 8;

/** Normalised company name: case, punctuation and legal form removed. Brackets that hold digits are kept. */
function keyFromName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(([^)]*)\)/g, (m, inner) => (/\d/.test(inner) ? ` ${inner} ` : ' '))
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !LEGAL.has(t))
    .join('');
}

/** Same normalisation for a slug such as "tracks-concrete-2002-limited". */
function keyFromSlug(slug) {
  return slug
    .replace(/-in-(liquidation|receivership)$/, '')
    .split('-')
    .filter((t) => t && !LEGAL.has(t))
    .join('');
}

/** Joint records ("a-limited-and-b-limited", "x-trading-as-y") are split so each company matches on its own. */
function partKeys(slug) {
  return slug.split(/-(?:and|trading-as)-/).map(keyFromSlug).filter(Boolean);
}

function displayFromSlug(slug) {
  return slug.split('-').map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 300) };
  }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').replace(/\s+/g, ' ').trim();
  const K = keyFromName(name);
  try {
    if (!K) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITEMAP_INDEX, excerpt: 'no company name left after removing the legal form' };
    }

    const index = await fetchText(SITEMAP_INDEX);
    if (!index.ok) {
      return { status: 'couldnt_check', reason: index.reason, records: [], source_url: SITEMAP_INDEX, excerpt: index.excerpt };
    }
    const isIndex = /<sitemapindex/i.test(index.text);
    const locs = [...index.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const subUrls = isIndex ? locs : [SITEMAP_INDEX];

    const subs = await mapLimit(subUrls, FETCH_CONCURRENCY, async (u) => ({ url: u, res: isIndex ? await fetchText(u) : { ok: true, text: index.text } }));

    const failed = subs.find((s) => !s.res.ok);
    const hits = [];
    const seen = new Set();
    let registerPages = 0;
    for (const s of subs) {
      if (!s.res.ok) continue;
      for (const m of s.res.text.matchAll(/<url>\s*<loc>\s*([^<]+?)\s*<\/loc>(?:\s*<lastmod>\s*([^<]*?)\s*<\/lastmod>)?/g)) {
        const loc = m[1].replace(/&amp;/g, '&');
        const lastmod = m[2] || '';
        for (const reg of REGISTERS) {
          const slugMatch = loc.match(reg.re);
          if (!slugMatch) continue;
          registerPages++;
          const slug = slugMatch[1];
          const keys = [keyFromSlug(slug), ...partKeys(slug)];
          if (keys.includes(K) && !seen.has(loc)) {
            seen.add(loc);
            hits.push({ name: displayFromSlug(slug), name_source: 'url slug (sitemap)', register: reg.register, url: loc, lastmod });
          }
        }
      }
    }

    if (hits.length > 0) {
      return {
        status: 'found', reason: '', records: hits,
        source_url: hits[0].url,
        excerpt: `${hits.length} register page(s) for "${name}" in the sitemap; ${hits[0].register}, last modified ${hits[0].lastmod || 'unknown'}.`.slice(0, 500),
      };
    }
    if (failed) {
      return {
        status: 'couldnt_check', reason: failed.res.reason, records: [], source_url: failed.url,
        excerpt: `sitemap file could not be read: ${failed.res.excerpt}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: SITEMAP_INDEX,
      excerpt: `No court-summary or accepted-undertaking page named "${name}" in ${subUrls.length} sitemap files (${registerPages} register pages listed).`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITEMAP_INDEX, excerpt: String(err?.message || err).slice(0, 500) };
  }
}
