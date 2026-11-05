// AMMI (Association of Malaysian Medical Industries) member directory.
// Tier 1: the whole member list is server-rendered HTML on one public page
// (a TablePress table with Company Name / Membership Type / Location / Technology).
// No search form, no JSON API, no JavaScript needed: one plain GET returns every member,
// so the lookup is a local match against that fixed list.

const LIST_URL = 'https://ammi.com.my/about-us/ammi-member/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const meta = {
  task: 'MY-ammi.com.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'membership_type', 'location', 'technology'],
  canary: { found: 'Top Glove Sdn Bhd', not_found: 'O2O Digital' },
};

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#038': '&',
  '#8217': '\u2019', '#8211': '\u2013', '#8212': '\u2014', '#039': "'", '#8220': '"', '#8221': '"',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+|#\d+);/g, (m, k) => (ENT[k] !== undefined ? ENT[k] : m));
}

function cellText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CORP = new Set(['sdn', 'bhd', 'sdnbhd', 'berhad', 'plc', 'ltd', 'limited', 'co', 'company']);

function tokens(s) {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function coreTokens(s) {
  const t = tokens(s);
  while (t.length > 1 && CORP.has(t[t.length - 1])) t.pop();
  return t;
}

function tokEq(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

/** true if `needle` appears as a contiguous (fuzzy) token run inside `hay`. */
function runInside(needle, hay) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!tokEq(needle[j], hay[i + j])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function matches(kw, name) {
  const k = coreTokens(kw);
  const n = coreTokens(name);
  if (!k.length || !n.length) return false;
  if (runInside(k, n)) return true;
  // query longer than the record (e.g. "Top Glove Sdn Bhd Malaysia"): record tokens appear in the query
  if (k.length > n.length && runInside(n, k)) return true;
  return false;
}

function parseMembers(html) {
  const start = html.indexOf('id="tablepress-3-no-2"');
  if (start < 0) return null;
  const end = html.indexOf('</table>', start);
  if (end < 0) return null;
  const table = html.slice(start, end);
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = [];
  for (const r of rows) {
    const cells = [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length < 3) continue;
    const name = cells[0];
    if (!name) continue;
    out.push({
      name,
      membership_type: cells[1] || '',
      location: cells[2] || '',
      technology: (cells[3] || '').replace(/•/g, '•').trim(),
    });
  }
  return out.length ? out : null;
}

async function getPage() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(LIST_URL, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

export default async function lookup(keyword) {
  const kw = (keyword || '').trim();
  if (!kw) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
  }

  let page;
  try {
    page = await getPage();
  } catch (e) {
    const timeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String((e && e.message) || e).slice(0, 300),
    };
  }

  const { status, body } = page;
  const low = body.slice(0, 4000).toLowerCase();
  if (status === 403 || status === 429 || status === 503) {
    const blocked = /cloudflare|captcha|just a moment|access denied|attention required/.test(low);
    return {
      status: 'couldnt_check',
      reason: blocked ? 'blocked' : 'http_error',
      records: [],
      source_url: LIST_URL,
      excerpt: `HTTP ${status}: ${cellText(body.slice(0, 300))}`,
    };
  }
  if (status !== 200) {
    return {
      status: 'couldnt_check',
      reason: 'http_error',
      records: [],
      source_url: LIST_URL,
      excerpt: `HTTP ${status}`,
    };
  }

  // layout check: the member table and its headers must still be there
  const hasHeader =
    /<th[^>]*>\s*Company Name\s*<\/th>/i.test(body) && /<th[^>]*>\s*Membership Type\s*<\/th>/i.test(body);
  const members = hasHeader ? parseMembers(body) : null;
  if (!members) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: LIST_URL,
      excerpt: cellText(body.slice(0, 400)),
    };
  }

  const hits = members.filter((m) => matches(kw, m.name));
  if (!hits.length) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt: `AMMI member list read (${members.length} member rows), no row matched "${kw}".`,
    };
  }

  const excerpt = hits
    .slice(0, 3)
    .map((m) => `${m.name} | ${m.membership_type} | ${m.location} | ${m.technology}`)
    .join('  ||  ')
    .slice(0, 500);

  return {
    status: 'found',
    reason: '',
    records: hits.slice(0, 20),
    source_url: LIST_URL,
    excerpt,
  };
}
