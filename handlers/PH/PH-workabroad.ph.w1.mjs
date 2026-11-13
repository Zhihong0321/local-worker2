export const meta = {
  task: 'PH-workabroad.ph',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'dmw_license_no', 'license_valid_from', 'license_valid_to', 'profile_url'],
  canary: { found: 'CAMOX PHILIPPINES INC.', not_found: 'Kumpanyang Walang Lisensya Inc.' },
};

const BASE = 'https://www.workabroad.ph';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' };
const MAX_PAGES = 6;          // result pages scanned per lookup
const DEADLINE_MS = 40000;    // stop starting new requests after this (the whole call must end under 60 s)
const LEGAL = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'OPC', 'LLC']);
const CARD_RE = /<h3>\s*<a href="([^"]*\/profile\/agency\/(\d+)\/[^"]*)"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/a>\s*<\/h3>\s*<h6>\s*<span[^>]*>([\s\S]*?)<\/span>/g;

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Key used to compare names: case, accents, punctuation and legal form ignored. "CAMOX PHILIPPINES, INC." == "Camox Philippines Inc" */
function compareKey(name) {
  const tokens = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Search text sent to the site: the site does not ignore punctuation (a comma gives no results), so drop it and the legal form. */
function searchQuery(keyword) {
  const tokens = String(keyword || '').normalize('NFC').replace(/[^\p{L}\p{N}&\- ]+/gu, ' ')
    .trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1].toUpperCase())) tokens.pop();
  return tokens.join(' ');
}

function searchUrl(keyword) {
  return `${BASE}/search-agency/n/${encodeURIComponent(searchQuery(keyword))}/1`;
}

function parseCards(html) {
  const cards = [];
  const seen = new Set();
  for (const m of html.matchAll(CARD_RE)) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({
      id,
      profile_url: new URL(decodeEntities(m[1]), BASE).href,
      name: cleanText(m[3]),
      license_no: cleanText(m[4]),
    });
  }
  return cards;
}

function isBlocked(html, finalUrl) {
  return /<title>\s*Just a moment|cf-chl|challenge-platform|Attention Required!\s*\|\s*Cloudflare/i.test(html)
    || /\/login(\/|\?|$)/i.test(finalUrl || '');
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Licence dates are only on the agency profile page. A failure here does not drop the match. */
async function licenceDates(profileUrl) {
  try {
    const res = await fetch(profileUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return {};
    const text = cleanText(await res.text());
    const m = text.match(/License Valid from (.+?) to (.+?) DMW \(formerly POEA\) License No/i);
    return m ? { license_valid_from: m[1].trim(), license_valid_to: m[2].trim() } : {};
  } catch {
    return {};
  }
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const key = compareKey(keyword);
  if (!key) return couldnt('other', '', 'empty company name');

  const sourceUrl = searchUrl(keyword);
  let url = sourceUrl;
  let pages = 0;
  let truncated = false;
  let totalCards = 0;
  const hits = new Map();

  try {
    while (url) {
      if (pages >= MAX_PAGES) { truncated = true; break; }
      if (Date.now() - started > DEADLINE_MS) return couldnt('timeout', sourceUrl, `search did not finish within ${DEADLINE_MS / 1000} s`);

      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      pages++;
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const html = await res.text();
      if (isBlocked(html, res.url)) return couldnt('blocked', url, 'bot check or login page');
      if (!html.includes('Search by DMW (formerly POEA) Licensed Agencies')) {
        return couldnt('layout_changed', url, cleanText(html));
      }

      const cards = parseCards(html);
      if (cards.length === 0) {
        if (pages === 1 && html.includes('No Results Found')) break; // the site answered: nothing listed
        return couldnt('layout_changed', url, cleanText(html));
      }
      totalCards += cards.length;
      for (const c of cards) {
        if (compareKey(c.name) === key && !hits.has(c.id)) hits.set(c.id, c);
      }

      const next = html.match(/<a[^>]*href="([^"]+)"[^>]*\brel="next"/i);
      url = next ? new URL(decodeEntities(next[1]), url).href : null;
    }

    if (hits.size === 0) {
      if (truncated) {
        return couldnt('other', sourceUrl, `no exact match in the first ${MAX_PAGES} result pages; more pages exist`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: totalCards ? `${totalCards} agencies listed, none named "${keyword}"` : 'No Results Found',
      };
    }

    const records = [];
    for (const c of hits.values()) {
      if (Date.now() - started > DEADLINE_MS) break;
      const dates = await licenceDates(c.profile_url);
      records.push({
        name: c.name,
        dmw_license_no: c.license_no,
        license_valid_from: dates.license_valid_from || '',
        license_valid_to: dates.license_valid_to || '',
        profile_url: c.profile_url,
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: records.map(r => `${r.name} | DMW licence ${r.dmw_license_no}`).join(' ; ').slice(0, 500),
    };
  } catch (err) {
    return couldnt('other', sourceUrl, String(err?.message || err));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await lookupOnce(keyword);
  } catch (err) {
    answer = couldnt('other', '', String(err?.message || err));
  }
  // Let the open sockets close before the worker exits: on Windows, Node 24 can abort at exit otherwise.
  await new Promise(resolve => setTimeout(resolve, 500));
  return answer;
}
