export const meta = {
  task: 'JP-tokyo-cci.or.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'representative', 'industry', 'area', 'founded', 'business', 'corporate_site', 'profile_url'],
  canary: { found: '株式会社オーミック', not_found: '株式会社ゼッタイニナイ商事' },
};

// Source: 東商 社長ネット (member-company profile directory on tokyo-cci.or.jp).
// Free-word search: GET /shachonet/search/?freeword=..., further pages: POST /shachonet/search/index.html (pageNum).
const BASE = 'https://www.tokyo-cci.or.jp';
const SEARCH_PATH = '/shachonet/search/';
const PAGING_PATH = '/shachonet/search/index.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // at most 100 search hits are read
const START_CUTOFF_MS = 30000; // no new request starts after 30 s (each request has its own 25 s timeout)
const MAX_PROFILES = 3;       // profile pages read per lookup

const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|特定非営利活動法人|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社団法人|財団法人|\(株\)|\(有\)|\(同\)|\(合\)|\(名\)|\(資\)|\bco\.?,?\s*ltd\.?|\bltd\.?|\binc\.?|\bcorp\.?|\bcorporation\b|\bllc\b|\bco\b|\bk\.?k\.?\b/gi;

class Fail extends Error {
  constructor(reason, message, url) {
    super(message);
    this.reason = reason;
    this.url = url;
  }
}

function nfkc(s) {
  return String(s ?? '').normalize('NFKC');
}

/** Drop a bracketed alias such as （クロスブリッジ) so "Cross Bridge（クロスブリッジ）" also matches "Cross Bridge". */
function stripAliases(s) {
  return s.replace(/[（(][^）)]*[）)]/g, ' ');
}

/** Name with legal form and punctuation removed, normalised for comparison. */
function coreOf(s) {
  return nfkc(s).toLowerCase().replace(LEGAL_FORMS, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Text sent to the site's search: legal form and aliases removed, punctuation turned into spaces. */
function searchTerm(name) {
  return stripAliases(nfkc(name)).replace(LEGAL_FORMS, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchKeys(name) {
  const full = coreOf(name);
  const bare = coreOf(stripAliases(nfkc(name)));
  return new Set([full, bare].filter(Boolean));
}

/** True only when the normalised names are equal (legal form, case, width and punctuation ignored). */
function sameCompany(userName, siteName) {
  const siteKeys = matchKeys(siteName);
  for (const k of matchKeys(userName)) {
    if (siteKeys.has(k)) return true;
  }
  return false;
}

function decode(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Fail('timeout', `no answer in 25 s: ${url}`, url);
    throw new Fail('other', `network error: ${String(e?.message || e).slice(0, 200)}`, url);
  }
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);
  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Fail('timeout', `body not read in 25 s: ${url}`, url);
    throw new Fail('other', `body read failed: ${String(e?.message || e).slice(0, 200)}`, url);
  }
  if (/captcha|cf-chl|challenge-platform|access denied/i.test(text)) throw new Fail('blocked', 'bot check or captcha page', url);
  return text;
}

function parseCount(html) {
  const m = html.match(/検索結果\s*(\d+)\s*件\s*[／/]\s*(?:<span>)?\s*(\d+)\s*件中/);
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null;
}

function parseCards(html) {
  const cards = [];
  for (const part of html.split('<li class="shachonet__cards__list">').slice(1)) {
    const idm = part.match(/href="\/shachonet\/profile\/([^"]+?)\.html"/);
    const titm = part.match(/<h3 class="shachonet__card__title">([\s\S]*?)<\/h3>/);
    if (!idm || !titm) continue;
    const repm = part.match(/<p class="shachonet__card__name">([\s\S]*?)<\/p>/);
    const tagm = part.match(/<div class="shachonet__card__tag">\s*<p>([\s\S]*?)<\/p>/);
    cards.push({
      id: idm[1],
      name: decode(titm[1]),
      representative: decode(repm?.[1]),
      industry: decode(tagm?.[1]),
    });
  }
  return cards;
}

function parseProfile(html) {
  const labels = {};
  const dl = html.match(/<dl class="profile__list">([\s\S]*?)<\/dl>/);
  if (dl) {
    const re = /<dt>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
    let m;
    while ((m = re.exec(dl[1]))) labels[decode(m[1])] = decode(m[2]);
  }
  const area = html.match(/<div class="shachonet__detail__area">\s*所在エリア[:：]([\s\S]*?)<\/div>/);
  return {
    representative: labels['代表者名'] || '',
    area: area ? decode(area[1]) : '',
    founded: labels['創業'] || '',
    business: labels['事業内容'] || '',
    corporate_site: labels['コーポレートサイト'] || '',
  };
}

/** Runs the free-word search and reads every result page the cut-offs allow. */
async function collectCards(term, t0) {
  const searchUrl = `${BASE}${SEARCH_PATH}?freeword=${encodeURIComponent(term)}`;
  const first = await fetchText(searchUrl);
  if (!/shachonet__cards|検索結果/.test(first)) throw new Fail('layout_changed', 'search page has no result section', searchUrl);
  const count = parseCount(first);
  if (!count) throw new Fail('layout_changed', 'result count not found on search page', searchUrl);

  let cards = parseCards(first);
  let scanned = cards.length;
  let page = 1;
  while (scanned < count.total && page < MAX_PAGES && Date.now() - t0 < START_CUTOFF_MS) {
    page += 1;
    const body = new URLSearchParams({
      freeword: term, area: '', 'cat-lg': '', 'cat-md': '', contact: '',
      es_from: '', es_to: '', birthplace: '', pageNum: String(page),
    });
    const html = await fetchText(`${BASE}${PAGING_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const pageCards = parseCards(html);
    if (!pageCards.length) throw new Fail('layout_changed', `result page ${page} had no cards`, `${BASE}${PAGING_PATH}`);
    cards = cards.concat(pageCards);
    scanned += pageCards.length;
  }
  return { cards, total: count.total, scanned, searchUrl };
}

/** Lookup one company on 東商 社長ネット. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const fallbackUrl = `${BASE}${SEARCH_PATH}`;
  try {
    const term = searchTerm(keyword);
    if (!term) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: fallbackUrl,
        excerpt: 'no company name left to search after removing the legal form' };
    }

    const { cards, total, scanned, searchUrl } = await collectCards(term, t0);
    const matches = cards.filter((c) => sameCompany(keyword, c.name));

    if (matches.length === 0) {
      if (scanned < total) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `${total} profiles match "${term}" but only the first ${scanned} could be read` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 of ${total} profiles on 東商 社長ネット match "${keyword}"` };
    }

    const records = [];
    for (let i = 0; i < matches.length && i < 10; i++) {
      const card = matches[i];
      const profileUrl = `${BASE}/shachonet/profile/${card.id}.html`;
      let detail = null;
      if (i < MAX_PROFILES && Date.now() - t0 < START_CUTOFF_MS) {
        try {
          detail = parseProfile(await fetchText(profileUrl));
        } catch (e) {
          detail = null; // the card already confirms the match; keep the card fields only
        }
      }
      records.push({
        name: card.name,
        representative: detail?.representative || card.representative,
        industry: card.industry,
        area: detail?.area || '',
        founded: detail?.founded || '',
        business: detail?.business || '',
        corporate_site: detail?.corporate_site || '',
        profile_url: profileUrl,
        profile_read: detail !== null,
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => `${r.name} / ${r.industry} / ${r.area}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    if (err instanceof Fail) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || fallbackUrl,
        excerpt: String(err.message).slice(0, 300) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: fallbackUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
