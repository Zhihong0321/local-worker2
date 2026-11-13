export const meta = { task: 'IN-siam.in', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'address', 'phone', 'website'],
  canary: { found: 'Maruti Suzuki India Ltd', not_found: 'श्री गणेश ऑटो प्राइवेट लिमिटेड' } };

const PAGE_URL = 'https://www.siam.in/about-us/members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['ltd', 'limited', 'pvt', 'private', 'pte', 'llp', 'inc', 'co', 'company', 'corp', 'corporation']);

/** Decode the few HTML entities the list uses and collapse whitespace. */
function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised comparison key: lower case, "&" = "and", no punctuation, no legal-form words. */
function keyOf(text) {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL.has(t))
    .join('');
}

/** Keys a listed name can be matched by: the plain name, and the name inside brackets (old name / unit of). */
function keysForListed(name) {
  const keys = new Set();
  const plain = name.replace(/\([^)]*\)/g, ' ');
  keys.add(keyOf(plain));
  for (const m of name.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1].replace(/^\s*(formerly known as|formerly|unit of)\s+/i, '');
    keys.add(keyOf(inner));
  }
  keys.delete('');
  return keys;
}

/** Parse every member block of the members list. Each block has a name, and a detail box with address, phone, website. */
function parseMembers(html) {
  const parts = html.split('class="member-detinf"').slice(1);
  const out = [];
  for (const part of parts) {
    const h4 = part.match(/<h4>([\s\S]*?)<\/h4>/i);
    if (!h4) continue;
    const name = decode(h4[1]);
    if (!name) continue;
    const addr = part.match(/member-location-on\.svg[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const phone = part.match(/member-phone\.svg[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const web = part.match(/member-open-globe\.svg[\s\S]*?href=['"]([^'"]+)['"]/i);
    out.push({
      name,
      address: addr ? decode(addr[1]) : '',
      phone: phone ? decode(phone[1]) : '',
      website: web ? web[1].trim() : '',
    });
  }
  return out;
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (!html.includes('member-detinf')) {
      if (/captcha|access denied|are you a robot/i.test(html)) return couldnt('blocked', 'bot or captcha page');
      return couldnt('layout_changed', decode(html).slice(0, 300));
    }

    const members = parseMembers(html);
    if (members.length === 0) return couldnt('layout_changed', 'member blocks found but no names parsed');

    const want = keyOf(decode(keyword));
    const records = want
      ? members.filter((m) => keysForListed(m.name).has(want))
      : [];

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `Not in the SIAM member list (${members.length} members listed)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE_URL,
      excerpt: records.map((r) => `${r.name} | ${r.address}`).join(' ; ').slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timedOut ? 'timeout' : 'other', String(err?.message || err));
  }
}
