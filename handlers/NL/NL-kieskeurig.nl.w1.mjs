export const meta = {
  task: 'NL-kieskeurig.nl',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'url', 'rating', 'review_count', 'address', 'phone', 'email'],
  canary: { found: 'Coolblue.nl', not_found: 'Zeeuwse Bloemkwekerij Onbekend B.V.' },
};

// The shop list page (/winkels) is behind a bot challenge (BunnyCDN Shield, HTTP 403) and is never fetched or
// solved here. Instead this reads the public shop sitemap that robots.txt names for crawlers: one <loc> per shop,
// /winkels/<slug>. A slug is the shop's domain or name, so matching is on the normalised slug. Each match then gets
// its info page, which has a schema.org block with the address, phone and aggregate rating.
const SITEMAP_URL = 'https://www.kieskeurig.nl/sitemap/sitemap-shops.xml.gz';
const SHOP_BASE = 'https://www.kieskeurig.nl/winkels/';
const MIN_SHOPS = 100; // fewer shop links than this means the sitemap is not as expected
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5',
};
const LEGAL_TOKENS = new Set(['bv', 'nv', 'vof', 'cv', 'holding', 'eenmanszaak', 'ltd', 'llc', 'gmbh', 'inc']);
const TLD_RE = /\.(nl|com|eu|be|de|shop|online|store|net|org)\b/g;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,5});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

function safeDecodeURI(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Compare key: lower case, no accents, no legal form, no web suffix, letters and digits only. */
function nameKey(raw) {
  let s = decodeEntities(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\s+/g, ' ').trim();
  s = s.split(' ').filter((t) => !LEGAL_TOKENS.has(t.replace(/[.,]/g, ''))).join(' ');
  s = s.replace(TLD_RE, '');
  return s.replace(/[^a-z0-9]/g, '');
}

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Shop slugs from the sitemap. Returns [{ slug, key }]. */
function parseShops(xml) {
  const seen = new Map();
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) {
    const loc = decodeEntities(m[1]);
    if (!loc.startsWith(SHOP_BASE)) continue;
    const slug = loc.slice(SHOP_BASE.length).replace(/\/+$/, '');
    if (!slug || /[/?#]/.test(slug) || seen.has(slug)) continue;
    seen.set(slug, nameKey(safeDecodeURI(slug)));
  }
  return [...seen].map(([slug, key]) => ({ slug, key })).filter((e) => e.key);
}

function walk(node, pred) {
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = walk(x, pred);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    if (pred(node)) return node;
    for (const k of Object.keys(node)) {
      const r = walk(node[k], pred);
      if (r) return r;
    }
  }
  return null;
}

function findShopOrg(html, slug) {
  const want = SHOP_BASE + slug;
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    // Physical shops are "Organization" with an address; online-only shops are "OnlineStore" with a rating and no address.
    const hit = walk(data, (o) => o.url === want && (o.address || o.aggregateRating));
    if (hit) return hit;
  }
  return null;
}

async function fetchShop(slug) {
  const url = SHOP_BASE + slug + '/informatie';
  const base = { name: slug, slug, url: SHOP_BASE + slug, info_url: url };
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return { ...base, detail_error: 'blocked HTTP ' + res.status };
    }
    if (!res.ok) {
      return { ...base, detail_error: 'http_error HTTP ' + res.status };
    }
    const html = await res.text();
    const org = findShopOrg(html, slug);
    if (!org) {
      return { ...base, detail_error: 'info page has no address or rating data' };
    }
    const a = org.address || {};
    const agg = org.aggregateRating || {};
    const address = [
      a.streetAddress,
      [a.postalCode, a.addressLocality].filter(Boolean).join(' '),
      a.addressCountry,
    ].filter(Boolean).join(', ');
    return {
      ...base,
      name: decodeEntities(org.name || slug),
      rating: agg.ratingValue ?? null,
      review_count: agg.reviewCount ?? null,
      address,
      phone: org.telephone || '',
      email: org.email || '',
    };
  } catch (err) {
    return {
      ...base,
      detail_error: (isTimeout(err) ? 'timeout: ' : 'other: ') + String(err?.message || err).slice(0, 200),
    };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = nameKey(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITEMAP_URL, excerpt: 'input has no usable name' };
    }

    let res;
    try {
      res = await fetch(SITEMAP_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (err) {
      return {
        status: 'couldnt_check',
        reason: isTimeout(err) ? 'timeout' : 'other',
        records: [],
        source_url: SITEMAP_URL,
        excerpt: String(err?.message || err).slice(0, 300),
      };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SITEMAP_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SITEMAP_URL, excerpt: `HTTP ${res.status}` };
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    let xml;
    try {
      xml = buf[0] === 0x1f && buf[1] === 0x8b
        ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : new TextDecoder().decode(buf);
    } catch (err) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITEMAP_URL, excerpt: 'could not unzip sitemap: ' + String(err).slice(0, 200) };
    }

    const shops = parseShops(xml);
    if (shops.length < MIN_SHOPS) {
      const challenge = /captcha|cf-chl|bunny-shield|just a moment|access denied|secure connection/i.test(xml);
      return {
        status: 'couldnt_check',
        reason: challenge ? 'blocked' : 'layout_changed',
        records: [],
        source_url: SITEMAP_URL,
        excerpt: challenge ? 'bot or challenge page instead of the sitemap' : `shop sitemap not as expected (${shops.length} shop links)`,
      };
    }

    const matches = shops.filter((s) => s.key === key);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SITEMAP_URL,
        excerpt: `No shop named "${keyword}" in the Kieskeurig shop sitemap (${shops.length} shops)`,
      };
    }

    // Each match gets its info page (in parallel, each with its own 25 s limit: at most ~50 s in total).
    const records = await Promise.all(matches.slice(0, 3).map((s) => fetchShop(s.slug)));
    const first = records[0];
    const excerpt = first.detail_error
      ? `Listed on Kieskeurig as "${first.name}"; info page not read (${first.detail_error})`
      : `Listed on Kieskeurig as "${first.name}": rating ${first.rating} from ${first.review_count} reviews`;

    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.info_url,
      excerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: isTimeout(err) ? 'timeout' : 'other',
      records: [],
      source_url: SITEMAP_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
