export const meta = {
  task: 'GB-feefo.com',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'feefo_url', 'name_source'],
  canary: { found: '1st Class Credit Union', not_found: 'Quillmarsh Reclamation Holdings Ltd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Feefo's own list of consumer merchant profile pages (the site's sitemap). Searching the site itself
// (/search-reviews/api/search) returns 403 for plain clients, so the list is used instead.
const SITEMAP_URL = 'https://www.feefo.com/consumer-sitemap.xml';
const UK_PROFILE = /^https:\/\/www\.feefo\.com\/en-GB\/reviews\/[^/?#]+$/;
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'cic']);

/** Normalised name key: case, accents, punctuation and trailing legal form removed. "&" counts as "and". */
function nameKey(text) {
  let s = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/['’]/g, '');
  const parts = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (parts.length && LEGAL_FORMS.has(parts[parts.length - 1])) parts.pop();
  return parts.join('');
}

function slugOf(url) {
  return decodeURIComponent(url.split('/').pop());
}

function nameFromSlug(slug) {
  return slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = nameKey(keyword);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITEMAP_URL, excerpt: 'the name has no letters or digits' };
    }

    const res = await fetch(SITEMAP_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SITEMAP_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SITEMAP_URL, excerpt: `HTTP ${res.status}` };
    }

    const xml = await res.text();
    if (!xml.includes('<urlset')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SITEMAP_URL, excerpt: xml.slice(0, 300) };
    }
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const profiles = locs.filter((u) => UK_PROFILE.test(u));
    // Sanity check: the list must look like Feefo's UK merchant list (about 3,800 entries when written).
    if (profiles.length < 100) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SITEMAP_URL, excerpt: `only ${profiles.length} UK profile links` };
    }

    const matches = profiles.filter((u) => nameKey(slugOf(u)) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SITEMAP_URL,
        excerpt: `no UK Feefo profile matches "${keyword}" (${profiles.length} profiles listed)`,
      };
    }

    const records = matches.map((u) => {
      const slug = slugOf(u);
      return { name: nameFromSlug(slug), slug, feefo_url: u, name_source: 'url_slug' };
    });
    return {
      status: 'found',
      reason: '',
      records,
      source_url: SITEMAP_URL,
      excerpt: matches.join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: SITEMAP_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
