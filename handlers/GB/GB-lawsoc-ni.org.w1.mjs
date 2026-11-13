export const meta = {
  task: 'GB-lawsoc-ni.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'phone', 'email', 'website', 'solicitors', 'areas_of_expertise', 'profile_url'],
  canary: { found: 'Adamson Rice', not_found: 'Xqzvbrlt Solicitors Ltd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://lawsoc-ni.org/using-a-solicitor/find-a-solicitor';
const SITE = 'https://lawsoc-ni.org';
// Legal forms and sector words that the site's firm names do not need to match on.
const TAIL_WORDS = ['ltd', 'limited', 'llp', 'llc', 'plc', 'co', 'company', 'inc', 'unlimited', 'ulc', 'and', 'solicitors', 'solicitor', ''];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&quot;/gi, '"')
    .replace(/&(#039|#39|apos);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripScripts(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ');
}

/** The name as sent to the site's search box: the legal form and sector words at the end are removed. */
function searchTerm(name) {
  const words = decodeEntities(name).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && TAIL_WORDS.includes(words[words.length - 1].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())) {
    words.pop();
  }
  return words.join(' ');
}

/** Normalised name used to compare a typed company name with a firm name on the site. */
function core(name) {
  const tokens = decodeEntities(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && TAIL_WORDS.includes(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  return tokens.join(' ');
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.8',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function failure(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function looksBlocked(html) {
  return /captcha|cf-chl|challenge-platform|are you a robot|access denied/i.test(html.slice(0, 20000));
}

function parseCards(scrubbed) {
  const cards = [];
  const re = /<a\s[^>]*?href="(https:\/\/lawsoc-ni\.org\/using-a-solicitor\/finding-a-solicitor\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(scrubbed))) {
    const inner = m[2];
    const h3 = inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h3) continue;
    const label = inner.match(/<h3[^>]*aria-label="([^"]*)"/i);
    const name = cleanText(label ? label[1] : h3[1]);
    const addr = inner.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
    cards.push({
      name,
      address: addr ? cleanText(addr[1]).replace(/\s+,/g, ',') : '',
      profile_url: m[1],
    });
  }
  return cards;
}

function parseDetail(html, card) {
  const s = stripScripts(html);
  const h1 = s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const contact = (s.match(/Contact Information<\/h2>([\s\S]*?)<\/section>/i) || [])[1] || '';
  const addr = contact.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  const mail = contact.match(/href="mailto:([^"]+)"/i);
  const tel = contact.match(/href="tel:([^"]+)"/i);
  const web = s.match(/class="hidden print:block">(https?:\/\/[^<]+)<\/span>/i);
  const solSec = (s.match(/Solicitors at this firm<\/h2>([\s\S]*?)(Areas of expertise<\/h2>|<\/main>|<footer)/i) || [])[1] || '';
  const solicitors = [...solSec.matchAll(/<span class="font-bold[^"]*">([\s\S]*?)<\/span>/gi)].map((x) => cleanText(x[1])).filter(Boolean);
  const areaSec = (s.match(/Areas of expertise<\/h2>([\s\S]*?)(<\/main>|<footer|<\/section>\s*<section)/i) || [])[1] || '';
  const areas = [...areaSec.matchAll(/<span class="font-bold[^"]*">([\s\S]*?)<\/span>/gi)].map((x) => cleanText(x[1])).filter(Boolean);
  return {
    name: h1 ? cleanText(h1[1]) : card.name,
    address: addr ? cleanText(addr[1]).replace(/\s+,/g, ',') : card.address,
    phone: tel ? cleanText(tel[1]) : '',
    email: mail ? cleanText(mail[1]) : '',
    website: web ? cleanText(web[1]) : '',
    solicitors,
    areas_of_expertise: areas,
    profile_url: card.profile_url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = BASE;
  try {
    const term = searchTerm(String(keyword || ''));
    if (!core(term)) {
      return failure('couldnt_check', 'other', BASE, 'empty company name');
    }
    searchUrl = `${BASE}?q=${encodeURIComponent(term)}&limit=9999`;

    const res = await get(searchUrl);
    if (res.status === 403 || res.status === 429) {
      return failure('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return failure('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
    }
    const html = await res.text();
    if (looksBlocked(html)) {
      return failure('couldnt_check', 'blocked', searchUrl, 'bot check or captcha page');
    }

    const scrubbed = stripScripts(html);
    const cards = parseCards(scrubbed);
    const noResults = /no results, please try again/i.test(scrubbed);
    const hasSearchForm = /name="q"/.test(scrubbed) && /solicitor/i.test(scrubbed);
    if (!hasSearchForm || (cards.length === 0 && !noResults)) {
      return failure('couldnt_check', 'layout_changed', searchUrl, cleanText(scrubbed).slice(0, 300));
    }

    const showing = scrubbed.match(/Showing:[\s\S]*?<strong>[^<]*<\/strong>\s*of\s*<strong>\s*(\d+)\s*<\/strong>/i);
    if (showing && Number(showing[1]) > cards.length) {
      return failure('couldnt_check', 'other', searchUrl,
        `site reports ${showing[1]} results but the page shows ${cards.length}`);
    }

    const want = core(keyword);
    const matches = cards.filter((c) => core(c.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: noResults
          ? `no results for "${term}"`
          : `${cards.length} result(s) for "${term}", none with the same name`,
      };
    }

    // Detail pages in parallel; if one fails, its record keeps the search-card data.
    const details = await Promise.allSettled(matches.map(async (card) => {
      const r = await get(card.profile_url);
      if (!r.ok) throw new Error(`detail HTTP ${r.status}`);
      return parseDetail(await r.text(), card);
    }));
    const records = details.map((d, i) => (d.status === 'fulfilled'
      ? d.value
      : { ...matches[i], solicitors: [], areas_of_expertise: [], phone: '', email: '', website: '', detail_error: String(d.reason?.message || d.reason).slice(0, 120) }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].profile_url,
      excerpt: `${records.length} match(es) for "${term}": ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return failure('couldnt_check', timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
