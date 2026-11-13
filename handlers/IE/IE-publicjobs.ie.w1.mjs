export const meta = {
  task: 'IE-publicjobs.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'listed_names', 'vacancy_count', 'vacancies'],
  canary: { found: 'Health Service Executive', not_found: 'Comhlacht Neamhliostaithe Teoranta' },
};

// publicjobs.ie has no company register. Its job board (run by TalentLink) lists every live vacancy with a
// "Department/Organisation" field. The site's keyword box searches vacancy titles only, so this handler reads the
// whole live list (50 per page, ?start=0,50,...) and matches the organisation name exactly after normalising it.
const BASE = 'https://publicjobs.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/candidate/jobboard/vacancy/3/adv/';
const PAGE = 50;
const MAX_LISTINGS = 500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'dac', 'clg', 'teoranta', 'plc', 'unlimited']);
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

function safeChar(cp, fallback) {
  try { return String.fromCodePoint(cp); } catch { return fallback; }
}

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const key = n.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : m;
    });
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower case, no accents, no punctuation, no leading "The", no trailing legal form (Limited, DAC, CLG, Teoranta ...). */
function normalise(s) {
  const t = decode(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’‘`"]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  if (words[0] === 'the') words.shift();
  return words.join(' ');
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
}

function parseListings(html) {
  return html.split('<li class="col-md-6 opp-container"').slice(1).map((chunk) => {
    const field = (label) => {
      const m = chunk.match(new RegExp(label + ':<\\/span>([\\s\\S]*?)<\\/div>'));
      return m ? clean(m[1]) : '';
    };
    const title = decode((chunk.match(/data-title="([^"]*)"/) || [])[1] || '').trim();
    const url = (chunk.match(/<a class="subject" href="([^"]+)"/) || [])[1] || BASE;
    return {
      org: field('Department\\/Organisation'),
      title,
      location: field('Location'),
      closing_date: field('Closing Date'),
      vacancy_type: field('Vacancy type'),
      url: decode(url),
    };
  });
}

function readTotal(html) {
  const m = html.match(/<h2[^>]*>\s*([\d,]+)\s+results match/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

async function getPage(start) {
  const url = start ? `${BASE}?start=${start}` : BASE;
  let res;
  let body;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    body = await res.text();
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: couldnt(timeout ? 'timeout' : 'other', url, String(err && err.message || err)) };
  }
  if (res.status === 403 || res.status === 429) return { fail: couldnt('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: couldnt('http_error', url, `HTTP ${res.status}`) };
  if (/captcha/i.test(body)) return { fail: couldnt('blocked', url, 'captcha page') };
  return { html: body };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalise(keyword);
    if (!key) return couldnt('other', BASE, 'empty company name');

    const first = await getPage(0);
    if (first.fail) return first.fail;
    const total = readTotal(first.html);
    if (total === null) return couldnt('layout_changed', BASE, first.html.slice(0, 300));
    if (total > MAX_LISTINGS) return couldnt('other', BASE, `${total} live listings, handler reads up to ${MAX_LISTINGS}`);

    const starts = [];
    for (let s = PAGE; s < total; s += PAGE) starts.push(s);
    const rest = await Promise.all(starts.map((s) => getPage(s)));
    const failed = rest.find((r) => r.fail);
    if (failed) return failed.fail;

    const listings = [first, ...rest].flatMap((p) => parseListings(p.html));
    if (listings.length !== total) {
      return couldnt('other', BASE, `read ${listings.length} of ${total} listings; the list changed while it was read`);
    }

    // A listing may give the full name and the short name joined by a dash ("Child and Family Agency - Tusla").
    // Either whole part matches the name exactly; a part is never matched as a substring.
    const namesOf = (org) => [normalise(org), ...org.split(/\s[-–—]\s/).map(normalise)];
    const matches = listings.filter((l) => namesOf(l.org).includes(key));
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE,
        excerpt: `Read all ${total} live listings on publicjobs.ie; none names "${keyword}" as the Department/Organisation`,
      };
    }

    const listedNames = [...new Set(matches.map((m) => m.org))];
    return {
      status: 'found',
      reason: '',
      records: [{
        name: listedNames[0],
        listed_names: listedNames,
        vacancy_count: matches.length,
        vacancies: matches.map(({ title, location, closing_date, vacancy_type, url }) => ({ title, location, closing_date, vacancy_type, url })),
      }],
      source_url: BASE,
      excerpt: `${matches.length} live vacancy listing(s) on publicjobs.ie name "${listedNames[0]}" as the Department/Organisation`,
    };
  } catch (err) {
    return couldnt('other', BASE, String(err && err.message || err));
  }
}
