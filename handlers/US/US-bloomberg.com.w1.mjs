export const meta = {
  task: 'US-bloomberg.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ticker', 'bloomberg_exchange_code', 'profile_url', 'legal_name', 'address', 'founded', 'website', 'telephone'],
  canary: { found: 'Apple Inc', not_found: 'Zxqvbnm Widgets Holdings LLC' },
};

const BASE = 'https://www.bloomberg.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words dropped before comparing names, so "APPLE INC." and "Apple Inc" compare as the same company.
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'plc', 'lp', 'llp', 'the']);
// The search page always carries this title, also when nothing is found.
const SEARCH_PAGE = /<title[^>]*>\s*Search Results Page\s*<\/title>/i;
const BLOCK_PAGE = /captcha|verify you are human|are you a robot|unusual traffic|access denied|request blocked/i;

function decodeEntities(s) {
  return (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised company name: lower case, punctuation removed, legal form removed. */
function nameKey(s) {
  return cleanText(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t))
    .join(' ');
}

function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Ticker and Bloomberg exchange code from a profile link such as /profile/company/AAPL:US. */
function recordFromLink(href, name) {
  const m = href.match(/\/profile\/company\/([^/?#]+)/);
  const code = m ? decodeURIComponent(m[1]) : '';
  const [ticker, exchange] = code.split(':');
  return {
    name,
    ticker: ticker || '',
    bloomberg_exchange_code: exchange || '',
    profile_url: new URL(href, BASE).href,
  };
}

/** Public company facts from the profile page's schema.org Corporation block. */
function profileFacts(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(m[1]); } catch { continue; }
    if (j && j['@type'] === 'Corporation') {
      const addr = typeof j.address === 'string'
        ? j.address
        : Object.values(j.address || {}).filter((v) => typeof v === 'string').join(', ');
      return {
        legal_name: String(j.name || '').trim(),
        address: addr.replace(/\s+/g, ' ').trim(),
        founded: String(j.foundingDate || '').trim(),
        website: String(j.url || '').trim(),
        telephone: String(j.telephone || '').trim(),
      };
    }
  }
  return null;
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause before returning lets the keep-alive socket close: on this Node build (Windows) the runner
 * otherwise exits in the middle of the socket teardown and aborts with exit 127 after the answer is printed.
 */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const typed = String(keyword || '').trim();
  const searchUrl = `${BASE}/search?query=${encodeURIComponent(typed)}`;
  const t0 = Date.now();
  try {
    const key = nameKey(typed);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
               excerpt: 'no company name left after removing the legal form' };
    }

    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!SEARCH_PAGE.test(html)) {
      if (BLOCK_PAGE.test(html.slice(0, 20000))) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot or captcha page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
               excerpt: cleanText(html).slice(0, 300) };
    }

    // Companies rail of the search page: <a href="/profile/company/AAPL:US" data-testid="search-result-companies">Apple Inc</a>
    const links = [...html.matchAll(/<a href="([^"]*)" data-testid="search-result-companies">([\s\S]*?)<\/a>/g)]
      .map((m) => ({ href: decodeEntities(m[1]), name: cleanText(m[2]) }));
    const matches = links.filter((l) => nameKey(l.name) === key);

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: links.length
          ? `Bloomberg shows ${links.length} company results, none named like "${typed}": ${links.map((l) => l.name).join('; ')}`.slice(0, 500)
          : `No company results for "${typed}"`,
      };
    }

    const records = matches.map((m) => recordFromLink(m.href, m.name));

    // Enrich each match from its profile page while the 60 s budget allows; a failed profile keeps the search fields.
    const notes = [];
    for (let i = 0; i < matches.length; i++) {
      if (Date.now() - t0 > 28000) { notes.push('profile not read: time budget'); break; }
      try {
        const pr = await get(records[i].profile_url);
        if (!pr.ok) { notes.push(`profile HTTP ${pr.status}`); continue; }
        const facts = profileFacts(await pr.text());
        if (facts) Object.assign(records[i], facts);
        else notes.push('profile has no company block');
      } catch (e) {
        notes.push('profile not read: ' + (e && e.name === 'TimeoutError' ? 'timeout' : String(e && e.message || e).slice(0, 80)));
      }
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: (`Bloomberg companies: ${records.map((r) => `${r.name} (${r.ticker}:${r.bloomberg_exchange_code})`).join('; ')}`
        + (notes.length ? ` [${notes.join('; ')}]` : '')).slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
