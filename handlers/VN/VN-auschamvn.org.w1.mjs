export const meta = { task: 'VN-auschamvn.org', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'category', 'profile_url', 'industry', 'city'],
  canary: { found: 'CÔNG TY TNHH DASAN VIỆT NAM', not_found: 'CÔNG TY TNHH MỘT THÀNH VIÊN ZZZ THƯƠNG MẠI' } };

const BASE = 'https://auschamvn.org';
const LIST_URL = `${BASE}/membership-directory/corporate`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words and phrases (already folded to a-z, space separated). Removed so that
// "ACME CO., LTD" and "ACME TRADING" style suffixes do not block a match on the core name.
const LEGAL_PHRASES = [
  'cong ty trach nhiem huu han mot thanh vien', 'cong ty trach nhiem huu han', 'cong ty co phan',
  'cong ty tnhh', 'cong ty', 'tnhh', 'co phan', 'joint stock company', 'company limited', 'pte ltd',
  'pty ltd', 'sdn bhd', 'co ltd', 'company ltd', 'corp ltd', 'limited', 'ltd', 'pty', 'pte', 'llc',
  'inc', 'corporation', 'corp', 'gmbh', 'plc', 'bhd', 'jsc', 'mtv', 'company', 'co',
];
const LEGAL_RE = new RegExp(`\\b(${LEGAL_PHRASES.join('|')})\\b`, 'g');

/** Lowercase, drop accents (Vietnamese diacritics included), keep letters and digits of any script, single spaces. */
function fold(s) {
  return String(s || '')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The company's core name: folded, with legal-form words removed. */
function core(s) {
  return fold(s).replace(LEGAL_RE, ' ').replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(s) {
  return decode(String(s || '').replace(/<[^>]+>/g, ' '));
}

function isChallenge(html) {
  return /cf-mitigated|challenge-platform|cf_chl_opt|<title>\s*Just a moment/i.test(html);
}

function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,vi;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  try {
    const want = core(name);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'no company name left after removing legal-form words' };
    }

    // Step 1: the corporate members list. The page holds the whole list (255 entries at the time of writing).
    let res;
    try {
      res = await get(LIST_URL);
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: LIST_URL, excerpt: String(e?.message || e).slice(0, 300) };
    }
    const listHtml = await res.text();

    if (res.status === 403 || res.status === 429 || isChallenge(listHtml)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}, bot check page` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const entries = new Map();
    const linkRe = /<h2>\s*<a[^>]*href="\/membership-directory\/corporate\/(\d+)[^"]*"[^>]*>([^<]*)<\/a>/g;
    let m;
    while ((m = linkRe.exec(listHtml)) !== null) {
      const id = m[1];
      const listed = decode(m[2]);
      if (listed && !entries.has(id)) entries.set(id, listed);
    }
    if (entries.size === 0 || !/Corporate Members/.test(listHtml)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: stripTags(listHtml).slice(0, 300) };
    }

    // Step 2: match on normalised core names (accents, case, punctuation and legal form removed). Exact match only.
    const matches = [...entries].filter(([, listed]) => core(listed) === want);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LIST_URL, excerpt: `"${name}" is not in the corporate members list (${entries.size} entries)` };
    }

    // Step 3: read each profile for industry and city. A failed profile read keeps the match from the list.
    const records = [];
    for (const [id, listed] of matches) {
      const profileUrl = `${BASE}/membership-directory/corporate/${id}`;
      let industry = '';
      let city = '';
      try {
        const pr = await get(profileUrl);
        if (pr.ok) {
          const pHtml = await pr.text();
          const ind = pHtml.match(/Business Industry:\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
          const cty = pHtml.match(/City:\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
          industry = ind ? stripTags(ind[1]) : '';
          city = cty ? stripTags(cty[1]) : '';
        }
      } catch (e) {
        // keep the list match; the profile fields stay empty
      }
      records.push({ name: listed, category: 'corporate', profile_url: profileUrl, industry, city });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `${records.length} match in the corporate members list: ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
