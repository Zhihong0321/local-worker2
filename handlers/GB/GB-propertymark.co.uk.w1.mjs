export const meta = {
  task: 'GB-propertymark.co.uk',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'location', 'address', 'phone', 'website', 'services', 'badges'],
  canary: { found: 'Foxtons Chiswick', not_found: 'Blarfington Quimbly Holdings Ltd' },
};

const BASE = 'https://www.propertymark.co.uk';
const SEARCH = `${BASE}/find-an-expert.html`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // search pages read per lookup (10 results each)
const DEADLINE_MS = 45000;    // whole lookup stays well under the 60 s limit
const DETAIL_MAX = 8;         // company pages read per lookup

const LEGAL_FORMS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'llc']);

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&#x27;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&ndash;|&mdash;/gi, '-');
}

function clean(html) {
  return decode((html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Letters and digits only, lower case; '&' is read as 'and'. */
function core(str) {
  return decode(str).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Comparison key: drop the address in brackets a directory adds to duplicate names, then a trailing legal form. */
function nameKey(str) {
  const words = core(decode(str).replace(/\s*\([^)]*\)\s*$/, '')).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The name to search for: the keyword as typed, minus a trailing legal form. */
function searchText(keyword) {
  const words = decode(keyword).replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(core(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

function errorAnswer(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

async function get(url, timeoutMs) {
  return fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-GB,en;q=0.9',
    },
    signal: AbortSignal.timeout(Math.max(1000, Math.min(25000, timeoutMs))),
  });
}

/** Reads the result cards on one search page. */
function parseCards(html) {
  const cards = [];
  for (const chunk of html.split('<div class="member-item">').slice(1)) {
    const m = chunk.match(/<h6 class="member-name">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const loc = chunk.match(/<span class="meta">([\s\S]*?)<\/span>/);
    cards.push({ url: decode(m[1]).trim(), name: clean(m[2]), location: loc ? clean(loc[1]) : '' });
  }
  return cards;
}

const isPhone = (l) => /^\+?[\d\s()-]{8,}$/.test(l);

/** Reads one company page: address, phone, website, services and the badge images it shows. No email is kept. */
function parseCompany(html, card) {
  const title = html.match(/<h1 class="title">([\s\S]*?)<\/h1>/);
  const details = html.match(/<div class="details">([\s\S]*?)<\/div>/);
  const body = details ? details[1].replace(/<h6[\s\S]*?<\/h6>/, '') : '';
  const lines = clean(body).split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('[email'));
  const phone = lines.find(isPhone) || '';
  const address = lines.find((l) => !isPhone(l)) || '';
  const web = body.match(/<a href="([^"]+)"[^>]*target="_blank"/);
  const services = [];
  const svc = html.match(/<h6>Services<\/h6>([\s\S]*?)<\/ul>/);
  if (svc) for (const li of svc[1].match(/<li>([\s\S]*?)<\/li>/g) || []) services.push(clean(li));
  const badges = [];
  const logos = html.match(/<div class="widget member-derectory-logo">([\s\S]*?)<\/div>\s*<\/div>/);
  if (logos) for (const src of logos[1].match(/src="[^"]*\/([^"\/]+)"/g) || []) {
    badges.push(decodeURIComponent(src.replace(/^src="[^"]*\//, '').replace(/"$/, '')));
  }
  return {
    name: title ? clean(title[1]) : card.name,
    url: card.url,
    location: card.location,
    address,
    phone,
    website: web ? decode(web[1]).replace(/^\/\//, 'https://') : '',
    services,
    badges,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - started);
  const searchUrl = (q, page) => `${SEARCH}?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;
  try {
    const q = searchText(keyword);
    const want = nameKey(q);
    if (!want) return errorAnswer('other', SEARCH, 'no company name in the keyword');
    const wantNoSpace = want.replace(/ /g, '');

    const matches = [];
    const seen = new Set();
    let complete = false;
    let sawAnyCard = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (left() < 5000) break;
      const url = searchUrl(q, page);
      let res;
      try { res = await get(url, left()); } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return errorAnswer(timedOut ? 'timeout' : 'other', url, err && err.message ? err.message : err);
      }
      if (res.status === 403 || res.status === 429) return errorAnswer('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return errorAnswer('http_error', url, `HTTP ${res.status}`);
      const html = await res.text();
      const cards = parseCards(html);
      if (cards.length === 0 && !/No results found/.test(html)) {
        if (/cf-chl|Just a moment|captcha/i.test(html)) return errorAnswer('blocked', url, 'bot check page');
        return errorAnswer('layout_changed', url, clean(html).slice(0, 300));
      }
      if (cards.length === 0) { complete = true; break; }   // past the last result, or "No results found"
      sawAnyCard = true;

      // The site lists the closest matches first: keep reading while a card still contains the name.
      let relevant = 0;
      for (const card of cards) {
        const key = nameKey(card.name);
        if (key.replace(/ /g, '').includes(wantNoSpace)) relevant++;
        if (key === want && !seen.has(card.url)) { seen.add(card.url); matches.push(card); }
      }
      if (relevant === 0) { complete = true; break; }
    }

    if (matches.length === 0) {
      if (!sawAnyCard) return { status: 'not_found', reason: '', records: [], source_url: searchUrl(q, 1), excerpt: 'No results found' };
      if (!complete) {
        return errorAnswer('other', searchUrl(q, 1), `no exact entry in the first ${MAX_PAGES} pages of results; the search is too broad to finish`);
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl(q, 1), excerpt: `No directory entry named "${want}"` };
    }

    const records = [];
    for (const card of matches) {
      if (records.length < DETAIL_MAX && left() > 5000) {
        try {
          const res = await get(card.url, left());
          if (res.ok) { records.push(parseCompany(await res.text(), card)); continue; }
        } catch { /* keep the listing data below */ }
      }
      records.push({ name: card.name, url: card.url, location: card.location, address: '', phone: '', website: '', services: [], badges: [] });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: `${records.length} exact entr${records.length === 1 ? 'y' : 'ies'} for "${want}" on Propertymark`,
    };
  } catch (err) {
    return errorAnswer('other', SEARCH, err && err.message ? err.message : err);
  }
}
