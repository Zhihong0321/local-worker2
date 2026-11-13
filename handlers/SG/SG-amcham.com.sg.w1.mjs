export const meta = { task: 'SG-amcham.com.sg', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'website'], canary: { found: 'Chevron Singapore Pte Ltd', not_found: 'Syarikat Fiktif Sdn Bhd' } };

const PAGE = 'https://amcham.com.sg/membership-directory-desktop/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

// Legal-form words dropped on both sides before comparing, so "X PTE LTD" matches "X Pte. Ltd.".
const LEGAL = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'llp', 'llc', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'sdn', 'bhd', 'plc', 'gmbh', 'na', 'lp']);

function normalize(s) {
  const t = String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** The directory is one static page: each member is a text item, followed by an optional "Website" link. */
function parseDirectory(html) {
  const start = html.indexOf('>0-A<');
  if (start < 0) return null;
  const end = html.indexOf('Events image gallery', start);
  if (end < 0) return null;
  const region = html.slice(start, end);
  const re = /<div id="n2-ss-\d+item\d+"[^>]*>([^<]*)<\/div>|href="([^"]+)"[^>]*>Website<\/a>/g;
  const out = [];
  let m;
  while ((m = re.exec(region)) !== null) {
    if (m[1] !== undefined) {
      const name = decode(m[1]);
      if (!name || /^[A-Z]$|^0-A$/.test(name)) continue;
      out.push({ name, website: '' });
    } else if (out.length && !out[out.length - 1].website) {
      out[out.length - 1].website = decode(m[2]);
    }
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalize(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const list = parseDirectory(html);
    if (!list || list.length === 0) {
      const looksBlocked = /captcha|challenge-platform|just a moment/i.test(html);
      return {
        status: 'couldnt_check',
        reason: looksBlocked ? 'blocked' : 'layout_changed',
        records: [],
        source_url: PAGE,
        excerpt: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
      };
    }

    const matches = list.filter((r) => normalize(r.name) === kw);
    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({ name: r.name, website: r.website })),
        source_url: PAGE,
        excerpt: matches.map((r) => (r.website ? `${r.name} | ${r.website}` : r.name)).join(' ; ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `No member named like "${keyword}" among ${list.length} listed members`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
