export const meta = {
  task: 'VN-vama.org.vn',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'member_url'],
  canary: { found: 'Công ty TNHH Việt Nam Suzuki', not_found: 'Công ty TNHH Hoàng Gia Không Tồn Tại' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The site is served on https. On some networks https is reset, while the site's own canonical link is http://vama.org.vn,
// so http is the fallback. Each base is tried only after a network error, never after an HTTP status.
const BASES = ['https://vama.org.vn', 'http://vama.org.vn'];

// The two public member directories: automaker members (NSX) and supporting-industry members (CNHT).
const LISTS = [
  { type: 'NSX', path: '/vn/cac-thanh-vien-nsx.html' },
  { type: 'CNHT', path: '/vn/cac-thanh-vien-cnht.html' },
];

// Legal-form words removed from the start and end of a name before comparing.
const LEGAL = new Set(['cong', 'ty', 'tnhh', 'co', 'phan', 'cp', 'lien', 'doanh', 'tong', 'ltd', 'limited', 'jsc', 'inc', 'corp', 'corporation', 'sdn', 'bhd']);

/** Lowercase, no accents, only a-z and 0-9 separated by single spaces. */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ|Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalised name without the legal form at either end. */
function core(s) {
  const t = norm(s).split(' ').filter(Boolean);
  while (t.length && LEGAL.has(t[0])) t.shift();
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** Comparison keys for a listed name: its core name, and the abbreviation in brackets if the site gives one. */
function keysOf(name) {
  const m = String(name).match(/^(.*?)\(([^()]+)\)\s*$/);
  const keys = new Set();
  const main = core(m ? m[1] : name);
  if (main) keys.add(main);
  if (m) {
    const abbr = norm(m[2]);
    if (abbr) keys.add(abbr);
  }
  return keys;
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#039;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Member cards: <div class="news-card__title"><a href="...">Name</a></div>. */
function parseMembers(html, pageUrl) {
  const out = [];
  const re = /<div class="news-card__title"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = decode(m[2]);
    if (!name) continue;
    out.push({ name, url: new URL(decode(m[1]), pageUrl).href });
  }
  return out;
}

/** Fetch one member list. Returns { ok, members, reason, url, excerpt }. Never throws. */
async function fetchList(list) {
  let last = { ok: false, reason: 'other', url: BASES[0] + list.path, excerpt: 'no response' };
  for (const base of BASES) {
    const url = base + list.path;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { ok: false, reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { ok: false, reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const members = parseMembers(html, url);
      if (!members.length) {
        return { ok: false, reason: 'layout_changed', url, excerpt: `no member cards on ${list.type} page` };
      }
      return { ok: true, members, reason: '', url, excerpt: '' };
    } catch (err) {
      last = {
        ok: false,
        reason: err && err.name === 'TimeoutError' ? 'timeout' : 'other',
        url,
        excerpt: String((err && err.message) || err).slice(0, 200),
      };
    }
  }
  return last;
}

/** Look one company up in the VAMA member lists. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    const keys = keysOf(name);
    if (!keys.size) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASES[0] + LISTS[0].path, excerpt: 'empty company name' };
    }

    const results = await Promise.all(LISTS.map(fetchList));

    const records = [];
    const matchedUrls = [];
    results.forEach((r, i) => {
      if (!r.ok) return;
      for (const member of r.members) {
        const memberKeys = keysOf(member.name);
        if ([...keys].some((k) => memberKeys.has(k))) {
          records.push({ name: member.name, list: LISTS[i].type, member_url: member.url });
          if (!matchedUrls.includes(r.url)) matchedUrls.push(r.url);
        }
      }
    });

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matchedUrls.join(' '),
        excerpt: `Listed in VAMA member directory: ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
      };
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return {
        status: 'couldnt_check',
        reason: failed[0].reason,
        records: [],
        source_url: failed.map((f) => f.url).join(' '),
        excerpt: failed[0].excerpt,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: results.map((r) => r.url).join(' '),
      excerpt: `Not in the VAMA member directories (${results.map((r, i) => `${r.members.length} ${LISTS[i].type}`).join(', ')} entries checked)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASES[0] + LISTS[0].path,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
