export const meta = {
  task: 'SG-sicci.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_category'],
  canary: { found: 'Adani Global Pte Ltd', not_found: '新加坡虚构贸易私人有限公司' },
};

const SOURCE_URL = 'https://sicci.com/member-directory/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_WORDS = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'llp']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function cleanText(s) {
  return decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, punctuation, "(S)" and legal form ignored. */
function normalise(s) {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(\s*s\s*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_WORDS.has(w))
    .join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (typeof keyword !== 'string' || normalise(keyword) === '') {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOURCE_URL, excerpt: 'empty company name' };
    }

    let res;
    try {
      res = await fetch(SOURCE_URL, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: SOURCE_URL, excerpt: String(err?.message || err).slice(0, 300) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SOURCE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const hasDirectory = html.includes('class="member-directory"');
    if (!hasDirectory) {
      const botWall = /challenge-platform|cf-chl|captcha/i.test(html);
      return {
        status: 'couldnt_check',
        reason: botWall ? 'blocked' : 'layout_changed',
        records: [],
        source_url: SOURCE_URL,
        excerpt: cleanText(html).slice(0, 300),
      };
    }

    // Each category: <h2 class="category-title">…</h2> followed by <ul class="member-list"> of <li> names.
    const sectionRe = /<h2 class="category-title">([\s\S]*?)<\/h2>\s*<ul class="member-list">([\s\S]*?)<\/ul>/g;
    const members = [];
    for (const section of html.matchAll(sectionRe)) {
      const category = cleanText(section[1]);
      for (const li of section[2].matchAll(/<li>([\s\S]*?)<\/li>/g)) {
        const name = cleanText(li[1]);
        if (name) members.push({ name, category });
      }
    }

    if (members.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SOURCE_URL, excerpt: 'member-directory found but no member lists parsed' };
    }

    const wanted = normalise(keyword);
    const records = members
      .filter((m) => normalise(m.name) === wanted)
      .map((m) => ({ name: m.name, membership_category: m.category }));

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SOURCE_URL,
        excerpt: `No entry matches "${keyword}" on the Member Directory (${members.length} names listed)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: SOURCE_URL,
      excerpt: `Member Directory lists "${records[0].name}" under ${records[0].membership_category}`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SOURCE_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
