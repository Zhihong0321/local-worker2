export const meta = {
  task: 'PH-philretailers.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'section', 'website', 'listing'],
  canary: { found: 'ABENSON LIBERTY APPLIANCE, INC.', not_found: 'Tindahang Sariling Atin Inc.' },
};

const DIRECTORY_URL = 'https://philretailers.com/pra-directory/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Trailing/leading words that only describe the legal form or an article; dropped before comparing names.
const LEGAL_WORDS = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'pte', 'private',
  'sdn', 'bhd', 'srl', 'llc', 'the',
]);

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] ?? m));
}

function cleanText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: letters and digits only (any script), '&' as 'and', legal-form words removed at both ends. */
function core(str) {
  const tokens = decodeEntities(str || '').replace(/&/g, ' and ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  while (tokens.length > 1 && LEGAL_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  while (tokens.length > 1 && LEGAL_WORDS.has(tokens[0])) tokens.shift();
  return tokens.join('');
}

/** Every member entry on the directory page, with its section heading and the keys it can be matched by. */
function parseEntries(html) {
  const entries = [];
  const tableRe = /<table[^>]*class="[^"]*tablepress[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let t;
  while ((t = tableRe.exec(html)) !== null) {
    const before = html.slice(0, t.index);
    const headings = before.match(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi) || [];
    const section = headings.length ? cleanText(headings[headings.length - 1].replace(/<\/?h[1-6][^>]*>/gi, '')) : '';
    const tbody = t[1].match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || t[1];
    const rows = tbody.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      // Some tables split one entry across several cells; the entry is all of a row's cells together.
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(cleanText).filter(Boolean);
      const text = cells.join(' ').trim();
      if (!text) continue;
      const href = row.match(/<a[^>]*href="([^"]+)"/i);
      const paren = text.match(/^([^(]*)\(([^)]*)\)/);
      const name = (paren ? paren[1] : text).trim();
      const legal = paren && !/chapter/i.test(paren[2]) ? paren[2].trim() : '';
      const keys = [...new Set([core(name), core(legal), core(text)].filter(Boolean))];
      entries.push({ name: name || text, legal_name: legal || name || text, section, website: href ? href[1] : '', listing: text, keys });
    }
  }
  return entries;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const wanted = core(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(DIRECTORY_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429 || res.status === 401) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const entries = parseEntries(html);
    if (entries.length === 0) {
      if (/captcha|cf-challenge|just a moment|verify you are human/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: html.slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: cleanText(html).slice(0, 300) };
    }

    const matches = entries.filter((e) => e.keys.includes(wanted));
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: DIRECTORY_URL,
        excerpt: `No entry on the PRA directory matches "${keyword}" (${entries.length} entries checked)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({
        name: e.name,
        legal_name: e.legal_name,
        section: e.section,
        website: e.website,
        listing: e.listing,
      })),
      source_url: DIRECTORY_URL,
      excerpt: matches[0].listing.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
