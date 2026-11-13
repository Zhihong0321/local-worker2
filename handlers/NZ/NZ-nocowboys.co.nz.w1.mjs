export const meta = {
  task: 'NZ-nocowboys.co.nz',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'registered_with_nocowboys', 'rating', 'location', 'address', 'phone', 'website'],
  canary: { found: 'Peter Jackson Plumbing Ltd', not_found: 'Kaitiaki Whakaora Tāne Limited' },
};

const BASE = 'https://www.nocowboys.co.nz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 100;
const MAX_PAGES = 5;
const DEADLINE_MS = 40000;
const LEGAL_WORDS = new Set(['ltd', 'limited', 'llc', 'inc', 'incorporated', 'lp']);

/** Compare names: lower case, no accents, "&" = "and", no punctuation, no legal form. */
function normName(s) {
  const t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

function decode(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&ndash;/gi, '–').replace(/&amp;/gi, '&')
    .replace(/&#39;|&#039;|&rsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function searchUrl(keyword, page) {
  const path = `/search-business/${encodeURIComponent(keyword)}` + (page > 1 ? `/${page}` : '');
  return `${BASE}${path}?per-page=${PER_PAGE}`;
}

function getPage(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-NZ,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function looksBlocked(html) {
  return /cf-chl|Just a moment\.\.\.|Attention Required! \| Cloudflare|captcha-delivery\.com|px-captcha|Access denied/i.test(html);
}

/** The result title reads "Name (N results found)". Returns N, or null when the marker is missing. */
function parseCount(html) {
  const m = html.match(/\((\d[\d,]*) results? found\)/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseItems(html) {
  const blocks = html.match(/<li class="businsess-search-business[\s\S]*?<\/li>/g) || [];
  const seen = new Map();
  for (const b of blocks) {
    const a = b.match(/<h3><a href="(\/businesses\/[^"?#]+)[^"]*"[^>]*>([\s\S]*?)<\/a><\/h3>/);
    if (!a || seen.has(a[1])) continue;
    const open = (b.match(/^<li[^>]*>/) || [''])[0];
    const text = decode(b);
    const rating = (text.match(/(\d+(?:\.\d+)?% from (?:one|\d+) ratings?|No ratings)/) || [])[1] || '';
    const loc = text.match(/Located in (.+?)(?=\s+–|$)/);
    seen.set(a[1], {
      name: decode(a[2]),
      href: a[1],
      registered: !/non-registered/.test(open),
      rating,
      location: loc ? loc[1].trim() : '',
      text: text.slice(0, 300),
    });
  }
  return [...seen.values()];
}

/** Pull the business's own LocalBusiness data (address, phone, website) from its profile page. */
function parseProfile(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      const hit = (Array.isArray(j) ? j : [j]).find((x) => x && x['@type'] === 'LocalBusiness');
      if (hit) {
        const a = hit.address;
        const raw = typeof a === 'string'
          ? a
          : a ? [a.streetAddress, a.addressLocality, a.postalCode].filter(Boolean).join(', ') : '';
        const address = decode(String(raw).replace(/<br\s*\/?>/gi, ' '));
        return { address, phone: hit.telephone || '', website: hit.url || '' };
      }
    } catch (e) {
      // an unreadable JSON-LD block is skipped
    }
  }
  return {};
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

async function buildFound(hits) {
  const records = [];
  for (const h of hits.slice(0, 5)) {
    const profileUrl = BASE + h.href;
    let prof = {};
    let profileNote = '';
    try {
      const r = await getPage(profileUrl);
      if (r.ok) prof = parseProfile(await r.text());
      else profileNote = `profile HTTP ${r.status}`;
    } catch (e) {
      profileNote = 'profile ' + (e && e.name === 'TimeoutError' ? 'timeout' : String(e && e.message || e).slice(0, 100));
    }
    records.push({
      name: h.name,
      profile_url: profileUrl,
      registered_with_nocowboys: h.registered ? 'yes' : 'no',
      rating: h.rating,
      location: h.location,
      address: prof.address || '',
      phone: prof.phone || '',
      website: prof.website || '',
      profile_note: profileNote,
    });
  }
  return {
    status: 'found',
    reason: '',
    records,
    source_url: records[0].profile_url,
    excerpt: hits[0].text,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const query = String(keyword || '').trim();
  const target = normName(query);
  if (!target) {
    return couldnt('other', BASE, 'empty company name, or only a legal form');
  }

  let lastUrl = searchUrl(query, 1);
  try {
    let total = null;
    let pagesNeeded = 1;
    for (let page = 1; page <= pagesNeeded; page++) {
      const url = searchUrl(query, page);
      lastUrl = url;
      const res = await getPage(url);
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      const count = parseCount(html);
      if (count === null) {
        if (looksBlocked(html)) return couldnt('blocked', url, 'bot or challenge page');
        return couldnt('layout_changed', url, decode(html).slice(0, 300));
      }
      total = count;
      pagesNeeded = Math.ceil(total / PER_PAGE);

      const items = parseItems(html);
      if (total > 0 && page === 1 && items.length === 0) {
        return couldnt('layout_changed', url, 'results counted but no business rows found');
      }

      const hits = items.filter((i) => normName(i.name) === target);
      if (hits.length) return await buildFound(hits);

      if (Date.now() - started > DEADLINE_MS && page < pagesNeeded) {
        return couldnt('timeout', url, `name not found on pages 1-${page}; ran out of time before page ${pagesNeeded}`);
      }
      if (page >= MAX_PAGES && pagesNeeded > MAX_PAGES) {
        return couldnt('other', url, `name not found in the first ${MAX_PAGES * PER_PAGE} of ${total} search results; not checked further`);
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: total === 0
        ? `0 results found for "${query}"`
        : `${total} results for "${query}", none with this name`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timedOut ? 'timeout' : 'other', lastUrl, String(err && err.message || err));
  }
}
