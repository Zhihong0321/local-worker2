export const meta = {
  task: 'AU-serviceseeking.com.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'business_id', 'abn', 'suburb', 'member_since', 'licences', 'badges', 'review_count', 'rating', 'profile_url'],
  canary: { found: 'DDJ Electrix', not_found: 'Zorblax Unlisted Testworks Pty Ltd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.serviceseeking.com.au';
const SITEMAP_URL = BASE + '/sitemaps/profile/profiles.xml.gz';
const LEGAL_WORDS = new Set(['pty', 'ltd', 'limited', 'proprietary', 'co', 'company', 'inc', 'incorporated']);
const MAX_PROFILES = 5;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

// Comparison key: lower case; '&', the word 'and', punctuation and legal-form words are dropped.
function nameKey(str) {
  return decodeEntities(str).toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && w !== 'and' && !LEGAL_WORDS.has(w))
    .join(' ');
}

// Profile URLs carry the business name as a hyphenated slug, e.g. /profile/148965-ddj-electrix
function slugKey(slug) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch (e) { /* keep raw slug */ }
  return nameKey(s.replace(/-/g, ' '));
}

function isTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

function looksBlocked(body) {
  return /captcha|cf-challenge|are you a robot|access denied/i.test(body || '');
}

function cc(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

function httpGet(url, accept) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Accept': accept, 'Connection': 'close' }, signal: AbortSignal.timeout(25000) });
}

function unJson(s) {
  try { return JSON.parse('"' + s + '"'); } catch (e) { return s; }
}

/** Reads one public profile page. Returns null when the page has no business data (layout changed or blocked). */
function parseProfile(html, url) {
  const nameM = html.match(/"businessName":"((?:[^"\\]|\\.)*)"/);
  if (!nameM) return null;
  const grab = (re) => { const m = html.match(re); return m ? m[1] : ''; };

  let licences = [];
  const licM = html.match(/"licences":(\[[^\]]*\])/);
  if (licM) {
    try {
      licences = JSON.parse(licM[1]).map((l) => ({
        number: l.number || '',
        type: (l.licence_type && l.licence_type.name) || '',
      }));
    } catch (e) { licences = []; }
  }

  let badges = [];
  const bi = html.indexOf('"badges":[');
  if (bi >= 0) {
    const chunk = html.slice(bi, html.indexOf(']', bi));
    badges = [...chunk.matchAll(/"label":"([^"]*)"/g)].map((m) => m[1]);
  }

  const idM = url.match(/\/profile\/(\d+)-/);
  return {
    name: decodeEntities(unJson(nameM[1])),
    business_id: idM ? idM[1] : grab(/"businessId":(\d+)/),
    abn: grab(/"abnNumber":(\d+)/),
    suburb: decodeEntities(unJson(grab(/"suburbName":"((?:[^"\\]|\\.)*)"/))),
    member_since: grab(/"memberSince":"([^"]*)"/),
    licences,
    badges,
    review_count: grab(/"reviewCount":"(\d+)"/) || grab(/"totalReviews":(\d+)/),
    rating: grab(/"rating":"([\d.]+)"/),
    profile_url: url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const text = String(keyword || '').trim();
  const key = nameKey(text);
  if (!key) return cc('other', SITEMAP_URL, 'no usable name in the keyword');

  try {
    // Step 1: the public profile list (sitemap). Plain gzip file, no login.
    const res = await httpGet(SITEMAP_URL, 'application/xml,text/xml,*/*;q=0.8');
    if (res.status === 403 || res.status === 429) return cc('blocked', SITEMAP_URL, `HTTP ${res.status}`);
    if (!res.ok) return cc('http_error', SITEMAP_URL, `HTTP ${res.status}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    let xml;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') return cc('other', SITEMAP_URL, 'no gzip support in this runtime');
      xml = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      xml = new TextDecoder().decode(bytes);
    }
    if (!xml.includes('<urlset')) {
      return cc(looksBlocked(xml) ? 'blocked' : 'layout_changed', SITEMAP_URL, xml.slice(0, 300));
    }

    const entries = [...xml.matchAll(/<loc>(https:\/\/www\.serviceseeking\.com\.au\/profile\/(\d+)-([^<\s]+))<\/loc>/g)];
    const candidates = entries.filter((m) => slugKey(m[3]) === key);
    if (candidates.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SITEMAP_URL,
        excerpt: `No business profile in the public profile list (${entries.length} profiles) has the name "${text}"`,
      };
    }

    // Step 2: read each candidate profile page and compare the real business name.
    const results = await Promise.all(candidates.slice(0, MAX_PROFILES).map(async (m) => {
      const url = m[1];
      try {
        const r = await httpGet(url, 'text/html,application/xhtml+xml,*/*;q=0.8');
        if (r.status === 403 || r.status === 429) return { fail: 'blocked', url, excerpt: `HTTP ${r.status}` };
        if (!r.ok) return { fail: 'http_error', url, excerpt: `HTTP ${r.status}` };
        const html = await r.text();
        const rec = parseProfile(html, url);
        if (!rec) return { fail: looksBlocked(html) ? 'blocked' : 'layout_changed', url, excerpt: html.slice(0, 200) };
        return { rec };
      } catch (e) {
        return { fail: isTimeout(e) ? 'timeout' : 'other', url, excerpt: String(e?.message || e) };
      }
    }));

    const matches = results.filter((r) => r.rec && nameKey(r.rec.name) === key).map((r) => r.rec);
    if (matches.length > 0) {
      const m = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: m.profile_url,
        excerpt: `${m.name} | ${m.suburb} | ABN ${m.abn} | member since ${m.member_since} | ${m.review_count} reviews`,
      };
    }

    const failed = results.find((r) => r.fail);
    if (failed) return cc(failed.fail, failed.url, failed.excerpt);

    return {
      status: 'not_found', reason: '', records: [], source_url: SITEMAP_URL,
      excerpt: `${candidates.length} profile(s) share this slug, but their business names differ from "${text}"`,
    };
  } catch (err) {
    return cc(isTimeout(err) ? 'timeout' : 'other', SITEMAP_URL, String(err?.message || err));
  }
}
