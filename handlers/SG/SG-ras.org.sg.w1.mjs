export const meta = {
  task: 'SG-ras.org.sg',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_category'],
  canary: { found: 'Killiney International Pte Ltd', not_found: 'Restoran Khayalan Pte Ltd' },
};

const LIST_URL = 'https://www.ras.org.sg/our-members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

// Compare-form of a name: lower case, "&" as "and", apostrophes dropped, other punctuation a space.
// Returns { base, kind } where kind is the legal form at the end ('PTE', 'SDN', 'LLP', 'LTD') or null.
function normalise(name) {
  let s = (name || '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  let kind = null;
  const tails = [
    [/ pte ltd$| pte limited$| private limited$| pvt ltd$/, 'PTE'],
    [/ sdn bhd$/, 'SDN'],
    [/ llp$/, 'LLP'],
    [/ ltd$| limited$/, 'LTD'],
  ];
  const padded = ' ' + s;
  for (const [re, k] of tails) {
    if (re.test(padded)) {
      kind = k;
      s = padded.replace(re, '').trim();
      break;
    }
  }
  return { base: s.replace(/ /g, ''), kind };
}

// A listed entry can carry a trade name or a second legal name in brackets: "Chrisna Jenio Pte Ltd (Auntie Anne's)".
function candidates(listed) {
  const main = listed.replace(/\(.*$/, '').trim();
  const inBrackets = [...listed.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  return [main, ...inBrackets];
}

function sameCompany(keywordForm, listedName) {
  return candidates(listedName).some((c) => {
    const f = normalise(c);
    if (!f.base || f.base !== keywordForm.base) return false;
    return !(keywordForm.kind && f.kind && keywordForm.kind !== f.kind);
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source_url = LIST_URL;
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (/cf-chl|Just a moment|Attention Required|captcha/i.test(html.slice(0, 20000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url, excerpt: 'bot check page' };
    }

    // The member list is rendered in the page: one <p class="members-roll-name"> per member, under three section headings.
    const sections = [...html.matchAll(/home-section-eyebrow">([^<]*)</g)].map((m) => ({
      at: m.index,
      label: decode(m[1]).replace(/^\s*\d+\s*\S\s*/, ''),
    }));
    const entries = [...html.matchAll(/<p[^>]*class="[^"]*members-roll-name[^"]*"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => ({
      at: m.index,
      name: decode(m[1].replace(/<[^>]+>/g, ' ')),
    }));
    if (entries.length < 50 || sections.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url,
        excerpt: `member list not as expected: ${entries.length} entries, ${sections.length} sections`,
      };
    }

    const keyword_ = decode(keyword);
    // Names here are written in English. A name with no Latin letters cannot be checked against this list.
    if (/[^\x00-\x7FÀ-ɏ\s.,&'’()\-\/]/u.test(keyword_) || !normalise(keyword_).base) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url,
        excerpt: `the directory lists members in English only; "${keyword_}" cannot be matched to it`,
      };
    }
    const kw = normalise(keyword_);

    const records = [];
    for (const e of entries) {
      if (!sameCompany(kw, e.name)) continue;
      let label = '';
      for (const s of sections) if (s.at < e.at) label = s.label;
      records.push({ name: e.name, membership_category: label });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url,
        excerpt: `"${keyword_}" is not among the ${entries.length} members listed on the site`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url,
      excerpt: records.map((r) => `${r.name} (${r.membership_category})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
