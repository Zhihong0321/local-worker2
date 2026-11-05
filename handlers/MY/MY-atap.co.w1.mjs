// Atap.co professional directory. One GET of
// https://atap.co/malaysia/en/professionals/s/{name} returns the firm cards
// (name, phone, location, Trusted/Verified badge, blurb). Sponsored cards are
// mixed in, so only a name match counts. Page 2+ is read only when page 1
// has no name match. The public card does not include customer review text.
export const meta = {
  task: 'MY-atap.co',
  want: 'w1',
  tier: 2,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'location', 'categories', 'phone', 'trusted', 'verified', 'reviews', 'blurb', 'profile_url'],
  canary: { found: 'DEzeno Sdn Bhd', not_found: '99 Speed Mart' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_PAGES = 3;
const STOP = new Set([
  'sdn', 'bhd', 'berhad', 'plt', 'plc', 'ltd', 'limited', 'inc', 'llc', 'pte',
  'holdings', 'holding', 'group', 'company', 'the', 'and', 'malaysia',
]);
let nextSlot = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decode(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(value) {
  let text = decode(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = text.replace(/\b(sdn|bhd|berhad|plt|plc|ltd|limited|inc|llc|pte)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length >= 2 ? stripped : text;
}

function namesMatch(keyword, candidate) {
  const left = norm(keyword);
  const right = norm(candidate);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 4 && right.includes(left)) return true;
  if (right.length >= 4 && left.includes(right) && left.split(' ').length <= right.split(' ').length + 1) return true;
  const tokens = left.split(' ').filter((token) => token.length >= 3);
  return tokens.length >= 2 && tokens.every((token) => right.split(' ').includes(token));
}

function couldnt(reason, sourceUrl, excerpt) {
  return {
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: sourceUrl,
    excerpt: String(excerpt || '').slice(0, 500),
  };
}

function badgeValue(chunk, kind) {
  const imgs = [...chunk.matchAll(new RegExp(`atap-${kind}(-gray)?\\.svg`, 'gi'))].map((item) => item[0].toLowerCase());
  if (!imgs.length) return 'absent';
  return imgs.some((item) => !item.includes('gray')) ? 'active' : 'inactive';
}

function parseCards(html) {
  return html.split('<div class="vendor-card').slice(1).map((chunk) => {
    const name = decode((chunk.match(/data-name="([^"]*)"/) || [])[1] || '');
    const slug = (chunk.match(/data-slug="([^"]*)"/) || [])[1] || '';
    const phone = decode((chunk.match(/class="hide">\s*([^<]+)/) || [])[1] || '');
    const categories = decode((chunk.match(/<div class="cat-link text-uppercase vendor-expertise">([\s\S]*?)<\/div>/) || [])[1] || '')
      .replace(/\s*\|\s*/g, ', ')
      .replace(/,\s*$/, '');
    const location = decode((chunk.match(/<div class="cat-link">([\s\S]*?)<\/div>/) || [])[1] || '');
    const blurb = decode((chunk.match(/vendor-excerpt desktop-show">([\s\S]*?)<\/div>/) || [])[1] || '');
    const reviews = /fa-star|customer review|rating/i.test(chunk) ? 'mentioned on card' : 'not published';
    return {
      name,
      location,
      categories,
      phone,
      trusted: badgeValue(chunk, 'trusted'),
      verified: badgeValue(chunk, 'verified'),
      reviews,
      blurb,
      profile_url: slug ? `https://atap.co/malaysia/en/professionals/${slug}` : '',
    };
  }).filter((card) => card.name);
}

async function fetchHtml(url) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = now + wait + 1000;
  if (wait) await sleep(wait);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return { error: couldnt(/timeout|aborted/i.test(message) ? 'timeout' : 'http_error', url, message) };
  }
  const html = await response.text();
  const head = html.slice(0, 800);
  if (
    response.status === 403
    || response.status === 429
    || /just a moment|cf-browser-verification|attention required|captcha/i.test(head)
  ) {
    return { error: couldnt('blocked', url, `HTTP ${response.status} ${head}`) };
  }
  if (!response.ok) return { error: couldnt('http_error', url, `HTTP ${response.status} ${head}`) };
  return { html, head, url };
}

async function fetchPage(url) {
  const got = await fetchHtml(url);
  if (got.error) return got;
  const { html, head } = got;
  if (!/Result(?:s)? Found/i.test(html)) return { error: couldnt('layout_changed', url, head) };
  const count = Number((html.match(/(\d+)\s+Malaysia Architect[\s\S]{0,80}?Result(?:s)? Found/i) || [])[1]);
  if (!Number.isFinite(count)) return { error: couldnt('layout_changed', url, 'missing result count') };
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((item) => Number(item[1])).filter((n) => n > 0);
  return { html, count, maxPage: Math.max(1, ...pages, 1), url };
}

function searchTerms(keyword) {
  const tokens = norm(keyword).split(' ').filter((token) => token.length >= 3 && !STOP.has(token));
  const terms = [];
  if (tokens.length === 1) terms.push(tokens[0]);
  if (!terms.includes(keyword)) terms.push(keyword);
  return terms;
}

async function searchTerm(term, keyword) {
  const base = `https://atap.co/malaysia/en/professionals/s/${encodeURIComponent(term)}`;
  let maxPage = 1;
  const records = [];
  let sourceUrl = base;
  for (let page = 1; page <= maxPage && page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? base : `${base}?page=${page}`;
    const result = await fetchPage(url);
    if (result.error) return result;
    sourceUrl = result.url;
    maxPage = Math.min(MAX_PAGES, Math.max(maxPage, result.maxPage));
    if (result.count > 0 && !result.html.includes('vendor-card')) {
      return { error: couldnt('layout_changed', url, 'result count without vendor cards') };
    }
    for (const card of parseCards(result.html)) {
      if (namesMatch(keyword, card.name) && !records.some((item) => item.profile_url === card.profile_url)) {
        records.push(card);
      }
    }
    if (records.length || page >= result.maxPage) break;
  }
  return { records, sourceUrl };
}

export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return couldnt('other', 'https://atap.co/malaysia/en/professionals', 'empty keyword');

    let records = [];
    let sourceUrl = `https://atap.co/malaysia/en/professionals/s/${encodeURIComponent(name)}`;
    for (const term of searchTerms(name)) {
      const result = await searchTerm(term, name);
      if (result.error) return result.error;
      sourceUrl = result.sourceUrl;
      records = result.records;
      if (records.length) break;
    }

    // Listing cards omit the badge block when it is the gray (inactive) asset.
    // The profile page still shows atap-trusted-gray.svg / atap-verified-gray.svg.
    for (const record of records.slice(0, 2)) {
      if (record.trusted !== 'absent' && record.verified !== 'absent') continue;
      if (!record.profile_url) continue;
      const profile = await fetchHtml(record.profile_url);
      if (profile.error) return profile.error;
      if (!profile.html.includes('vendor-title')) {
        return couldnt('layout_changed', record.profile_url, profile.head);
      }
      record.trusted = badgeValue(profile.html, 'trusted');
      record.verified = badgeValue(profile.html, 'verified');
      if (/fa-star|customer review/i.test(profile.html) && record.reviews === 'not published') {
        record.reviews = 'mentioned on profile';
      }
    }

    if (!records.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `No Atap professional name matched "${name}".`.slice(0, 500),
      };
    }

    const excerpt = records
      .map((record) => `${record.name} | ${record.location} | trusted ${record.trusted} | verified ${record.verified} | reviews ${record.reviews} | ${record.phone} | ${record.blurb}`)
      .join(' || ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url || sourceUrl,
      excerpt: excerpt.slice(0, 500),
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return couldnt(/timeout|aborted/i.test(message) ? 'timeout' : 'other', 'https://atap.co/malaysia/en/professionals', message);
  }
}
