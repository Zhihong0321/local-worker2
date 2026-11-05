// 4As Malaysia member roll. The /members page lazy-loads via JetEngine;
// the same published members are a public WP REST collection (one GET).
export const meta = {
  task: 'MY-aaaa.org.my',
  want: 'w1',
  tier: 1,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'member_type', 'location', 'url'],
  canary: { found: 'Dentsu (Malaysia) Sdn Bhd', not_found: 'Kingdom Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LIST = 'https://aaaa.org.my/wp-json/wp/v2/members?per_page=100&_fields=id,slug,link,title,class_list';

const STOP = new Set([
  'sdn', 'bhd', 'malaysia', 'malaysian', 'advertising', 'communications',
  'communication', 'worldwide', 'agency', 'studio', 'group', 'the', 'and',
  'marketing', 'consultant', 'consultants', 'services', 'service', 'integrated',
]);

let cache = null;
let cacheAt = 0;

function couldnt(reason, source_url, excerpt) {
  return {
    status: 'couldnt_check',
    reason,
    records: [],
    source_url,
    excerpt: String(excerpt || '').replace(/\s+/g, ' ').slice(0, 500),
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function norm(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(sdn\.?\s*bhd\.?|sendirian berhad|berhad|bhd\.?|plt\.?|plc|inc\.?|ltd\.?|limited)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}

function wholeWord(hay, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc + '\\b').test(hay);
}

function matches(keyword, title) {
  const a = norm(keyword);
  const b = norm(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && (b.includes(a) || (b.length >= 5 && a.includes(b)))) return true;
  const ta = tokens(keyword);
  if (!ta.length) return false;
  if (!ta.every((t) => wholeWord(b, t) || b.split(' ').some((u) => u === t))) return false;
  if (ta.length >= 2) return true;
  return ta[0].length >= 4;
}

function slugLabel(prefix, classList) {
  const hit = (classList || []).find((c) => c.startsWith(prefix));
  if (!hit) return '';
  return hit.slice(prefix.length).split('-').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function loadMembers() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const all = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 8) {
    const url = page === 1 ? LIST : LIST + '&page=' + page;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    const head = text.slice(0, 800);
    if (
      res.status === 401 || res.status === 403 || res.status === 429 ||
      /cf-browser-verification|just a moment|captcha|attention required|cloudflare/i.test(head)
    ) {
      const err = new Error('blocked');
      err.reason = 'blocked';
      err.url = url;
      err.excerpt = head;
      throw err;
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.reason = 'http_error';
      err.url = url;
      err.excerpt = 'HTTP ' + res.status + ' ' + head;
      throw err;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('json')) {
      const err = new Error('not json');
      err.reason = 'layout_changed';
      err.url = url;
      err.excerpt = head;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error('bad json');
      err.reason = 'layout_changed';
      err.url = url;
      err.excerpt = head;
      throw err;
    }
    if (!Array.isArray(data) || (data.length && typeof data[0]?.title?.rendered !== 'string')) {
      const err = new Error('unexpected shape');
      err.reason = 'layout_changed';
      err.url = url;
      err.excerpt = head;
      throw err;
    }
    const total = Number(res.headers.get('x-wp-total') || '0');
    const tp = Number(res.headers.get('x-wp-totalpages') || '0');
    if (page === 1 && (!Number.isFinite(total) || total < 1 || !Number.isFinite(tp) || tp < 1 || data.length < 1)) {
      const err = new Error('empty member roll');
      err.reason = 'layout_changed';
      err.url = url;
      err.excerpt = 'X-WP-Total=' + res.headers.get('x-wp-total') + ' items=' + data.length;
      throw err;
    }
    totalPages = tp;
    all.push(...data);
    if (page < totalPages) await new Promise((r) => setTimeout(r, 1100));
    page++;
  }
  cache = all;
  cacheAt = Date.now();
  return all;
}

export default async function lookup(keyword) {
  const source = 'https://aaaa.org.my/wp-json/wp/v2/members?per_page=100';
  try {
    const q = String(keyword ?? '').trim();
    if (!q) return couldnt('other', source, 'empty keyword');
    if (!norm(q)) return couldnt('other', source, 'keyword has no distinctive name');
    const all = await loadMembers();
    const hits = all.filter((item) => matches(q, item.title?.rendered || ''));
    if (!hits.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: source,
        excerpt: 'No 4As member title matched "' + q.slice(0, 160) + '" among ' + all.length + ' published member agencies.',
      };
    }
    const records = hits.map((item) => ({
      name: decodeEntities(item.title.rendered).replace(/\s+/g, ' ').trim(),
      member_type: slugLabel('member_type-', item.class_list),
      location: slugLabel('member_location-', item.class_list),
      url: item.link || '',
    }));
    const first = hits[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.link || source,
      excerpt: JSON.stringify({
        title: first.title.rendered,
        class_list: first.class_list,
        link: first.link,
      }).slice(0, 500),
    };
  } catch (err) {
    const reason = err?.reason || (/timeout|aborted|ETIMEDOUT/i.test(String(err?.message || err)) ? 'timeout' : 'other');
    return couldnt(reason, err?.url || source, err?.excerpt || err?.message || err);
  }
}
