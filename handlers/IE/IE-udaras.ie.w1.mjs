export const meta = {
  task: 'IE-udaras.ie',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'phone', 'email', 'website', 'categories', 'detail_url'],
  canary: { found: 'Gifts le Grá', not_found: 'Comhlacht Neamhliostaithe Teoranta' },
};

// The whole Eolaire (directory) is one static page: every entry is in the HTML, no pagination.
const DIRECTORY_URL = 'https://udaras.ie/faoin-udaras/eolaire/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

// Legal-form words/phrases (Irish and English) dropped before comparing names. Longest first.
const LEGAL_PHRASES = [
  'cuideachta phoibli theoranta', 'cuideachta phoibli', 'cuideachta theoranta',
  'theoranta', 'teoranta', 'teo', 'ltd', 'limited', 'plc', 'unlimited',
];

function codePointOr(code, fallback) {
  return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : fallback;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePointOr(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => codePointOr(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function cleanHtml(fragment) {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/(\s*,\s*)+/g, ', ')
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '');
}

/** Comparison key: no case, accents, punctuation, spaces or legal-form words. "Narosa Teoranta" === "NAROSA TEO." */
function matchKey(s) {
  const base = decodeEntities(s)
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let padded = ` ${base} `;
  for (const phrase of LEGAL_PHRASES) padded = padded.split(` ${phrase} `).join(' ');
  const key = padded.replace(/\s+/g, '');
  return key || base.replace(/\s+/g, '');
}

function parseDirectory(html) {
  const entries = [];
  for (const raw of html.split('<li id="infobox').slice(1)) {
    const chunk = raw.split('</li>')[0];
    const h3 = chunk.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i);
    if (!h3) continue;
    const name = cleanHtml(h3[2]);
    if (!name) continue;
    const address = chunk.match(/<\/h3>\s*<p>([\s\S]*?)<\/p>/i);
    const phone = chunk.match(/class="phonelink"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const email = chunk.match(/class="emaillink"[^>]*>\s*<a[^>]*href="mailto:([^"]*)"/i);
    const web = chunk.match(/class="weblink"[^>]*>\s*<a[^>]*href="([^"]*)"/i);
    const cats = chunk.match(/class="directory_cats cats"[^>]*>([\s\S]*?)<\/p>/i);
    entries.push({
      name,
      address: address ? cleanHtml(address[1]) : '',
      phone: phone ? cleanHtml(phone[1]) : '',
      email: email ? decodeEntities(email[1]).trim() : '',
      website: web ? decodeEntities(web[1]).trim() : '',
      categories: cats ? [...cats[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(m => cleanHtml(m[1])).filter(Boolean) : [],
      detail_url: new URL(decodeEntities(h3[1]), DIRECTORY_URL).href,
    });
  }
  return entries;
}

function failure(err) {
  const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
  return { status: 'couldnt_check', reason, records: [], source_url: DIRECTORY_URL, excerpt: String(err?.message || err).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword ?? '').trim();
    if (!input) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'empty company name' };
    }

    let res;
    try {
      res = await fetch(DIRECTORY_URL, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en,ga;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      return failure(err);
    }
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    let html;
    try {
      html = await res.text();
    } catch (err) {
      return failure(err);
    }

    const entries = parseDirectory(html);
    if (entries.length === 0) {
      if (/cf-chl|challenge-platform|Just a moment\.\.\./i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: 'bot check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL, excerpt: html.slice(0, 300) };
    }

    const key = matchKey(input);
    const matches = entries.filter(e => matchKey(e.name) === key);

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: DIRECTORY_URL,
        excerpt: `The directory lists ${entries.length} entries; none matches "${input}"`,
      };
    }

    return {
      status: 'found', reason: '', records: matches, source_url: DIRECTORY_URL,
      excerpt: `${matches[0].name} | ${matches[0].address} | ${matches[0].categories.join(', ')}`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
