export const meta = {
  task: 'AU-ausbanking.org.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership', 'address'],
  canary: { found: 'Commonwealth Bank of Australia', not_found: 'Quokka Heritage Bank Limited' },
};

const PAGE = 'https://www.ausbanking.org.au/about-us/aba-members/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words ignored when comparing names (case, punctuation and legal form are not part of the match).
const LEGAL_FORMS = new Set(['limited', 'ltd', 'pty', 'proprietary', 'incorporated', 'inc', 'co', 'company', 'corporation', 'corp', 'na']);

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&|\+/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/(,\s*)+/g, ', ').trim()).replace(/^,\s*|,\s*$/g, '');
}

/** Read every member card on the page: legal name (h6), membership section and address. */
function parseEntries(html) {
  const membersAt = html.indexOf('id="h-aba-members"');
  const assocAt = html.indexOf('id="associatemembers"');
  if (membersAt < 0 || assocAt < 0 || assocAt < membersAt) return null;

  const entries = [];
  const cardRe = /<div class="cgrid narrow">[\s\S]*?<h6[^>]*>([\s\S]*?)<\/h6>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(cardRe)) {
    const name = cleanText(m[1]);
    if (!name) continue;
    let membership;
    if (m.index > assocAt) membership = 'ABA associate member';
    else if (m.index > membersAt) membership = 'ABA member bank';
    else continue;
    const address = cleanText(m[2]).replace(/\bWebsite\b/g, '').replace(/^,\s*|,\s*$/g, '').trim();
    entries.push({ name, membership, address });
  }
  return entries;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalize(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'the company name has no letters or digits to compare' };
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const entries = parseEntries(html);
    if (!entries || entries.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: cleanText(html).slice(0, 300) };
    }

    const matches = entries.filter((e) => normalize(e.name) === kw);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `Checked ${entries.length} listed ABA members and associate members; no entry matches "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: PAGE,
      excerpt: matches.map((m) => `${m.name} (${m.membership})`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
