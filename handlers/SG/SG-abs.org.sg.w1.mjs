export const meta = { task: 'SG-abs.org.sg', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'licence_type', 'country_of_incorporation', 'membership_category'],
  canary: { found: 'DBS Bank Ltd', not_found: '新加坡海星贸易有限公司' } };

const PAGE = 'https://www.abs.org.sg/about-us/memberbanks';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that do not change which company is meant. Stripped from both sides before comparing.
const LEGAL = new Set(['pte', 'pt', 'ltd', 'limited', 'sdn', 'bhd', 'berhad', 'llc', 'llp', 'plc', 'inc', 'co', 'corp',
  'corporation', 'company', 'the', 'pvt', 'private', 'public', 'ag', 'sa', 'nv', 'gmbh', 'spa', 'asa', 'ab', 'bv',
  'tbk', 'persero', 'pjsc']);

function decode(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;|&#8217;/gi, "'");
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised name for comparing: case, accents, punctuation and legal form removed. */
function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(\s*(?:first |second )?(?:vice )?chairman bank\s*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .split(' ').filter((t) => t && !LEGAL.has(t)).join(' ');
}

/** Reads every member table on the page: name, licence type, country, membership category. */
function parseMembers(html) {
  const out = [];
  for (const t of html.matchAll(/<table\b[^>]*\bid="example[A-Za-z]*"[^>]*>([\s\S]*?)<\/table>/gi)) {
    for (const row of t[1].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
      if (cells.length >= 4 && cells[0]) {
        out.push({ name: cells[0], licence_type: cells[1], country_of_incorporation: cells[2], membership_category: cells[3] });
      }
    }
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = norm(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|access denied/i.test(html) && !/Licence Type/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: 'bot or access check page' };
    }

    const members = parseMembers(html);
    if (members.length < 10 || !/Licence Type/i.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE,
        excerpt: `member tables not as expected (${members.length} rows read)` };
    }

    // Exact match after normalising: a different entity (for example a branch with another name) is not a match.
    const hits = members.filter((m) => norm(m.name) === kw);
    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE,
        excerpt: `Not in the ABS member list (${members.length} members checked). The list covers ABS member institutions only.` };
    }

    return {
      status: 'found',
      reason: '',
      records: hits,
      source_url: PAGE,
      excerpt: hits.map((h) => `${h.name} | ${h.licence_type} | ${h.country_of_incorporation} | ${h.membership_category}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE,
      excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
