export const meta = { task: 'SG-britcham.org.sg', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'profile_url', 'website', 'description'],
  canary: { found: 'Airbus', not_found: '新加坡虚构科技有限公司' } };

// The BritCham corporate membership directory is one server-rendered page that lists every corporate member
// (about 240 entries). The site's "Search by Name" box is a client-side filter: the page ignores search parameters,
// so the handler reads the full list and compares names itself.
const SITE = 'https://www.britcham.org.sg';
const LIST_URL = `${SITE}/membership-directory/corporate`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};
// Legal-form words dropped before comparing names ("Pte. Ltd." and "Pte Ltd" are the same company).
const LEGAL_WORDS = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'llp', 'llc', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'sdn', 'bhd', 'berhad', 'gmbh', 'plc']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

function cleanText(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: accents and punctuation removed, "&" read as "and", legal-form words removed. */
function nameKey(s) {
  const folded = String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/&/g, ' and ');
  return folded.split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL_WORDS.has(t)).join('');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function parseList(html) {
  const byId = new Map();
  const re = /<a[^>]*href="\/membership-directory\/corporate\/(\d+)#page-member-ajax"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = cleanText(m[2]);
    if (!name || byId.has(m[1])) continue;
    byId.set(m[1], { name, profile_url: `${SITE}/membership-directory/corporate/${m[1]}`, key: nameKey(name) });
  }
  return [...byId.values()];
}

function get(url) {
  return fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
}

/** Adds website and description from the member's own page. A failure here keeps the list data. */
async function enrich(m) {
  const record = { name: m.name, profile_url: m.profile_url, website: '', description: '' };
  try {
    const res = await get(m.profile_url);
    if (res.ok) {
      const html = await res.text();
      const d = html.match(/<div class="member-description">([\s\S]*?)<\/div>/i);
      if (d) record.description = cleanText(d[1]).slice(0, 600);
      const w = html.match(/Company Website Address:[\s\S]{0,1000}?<a[^>]*href="([^"]+)"/i);
      if (w) record.website = decodeEntities(w[1]);
    }
  } catch {
    // keep the list data only
  }
  return record;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword ?? '').trim();
  if (!input) return fail('other', LIST_URL, 'empty company name');
  try {
    const res = await get(LIST_URL);
    if (res.status === 403 || res.status === 429) return fail('blocked', LIST_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', LIST_URL, `HTTP ${res.status}`);

    const html = await res.text();
    if (/cf-chl|Just a moment\.\.\.|Attention Required/i.test(html.slice(0, 20000))) {
      return fail('blocked', LIST_URL, 'bot check page');
    }

    const members = parseList(html);
    if (members.length < 20 || !/Membership Directory/.test(html)) {
      return fail('layout_changed', LIST_URL, `expected the member list, found ${members.length} entries`);
    }

    const target = nameKey(input);
    if (!target) return fail('other', LIST_URL, `no comparable name in "${input}"`);

    const matches = members.filter((m) => m.key === target);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `${members.length} corporate members listed; none matches "${input}"`,
      };
    }

    const records = await Promise.all(matches.slice(0, 5).map(enrich));
    return {
      status: 'found', reason: '', records, source_url: records[0].profile_url,
      excerpt: `${records[0].name} | ${records[0].profile_url} | ${records[0].description}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', LIST_URL, String(err?.message || err));
  }
}
