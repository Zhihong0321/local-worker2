export const meta = {
  task: 'MY-foundit.my',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'search_url'],
  canary: { found: 'Celestica Electronics (S) Pte Ltd', not_found: 'Syarikat Khayalan Tiada Rekod Sdn Bhd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words that are dropped before comparing names (Malaysian and common forms).
const LEGAL_FORM = new Set(['sdn', 'bhd', 'berhad', 'pte', 'ltd', 'limited', 'plc', 'llp', 'pvt', 'llc', 'inc', 'corp', 'corporation', 'enterprise', 'enterprises']);

/** Site slug for the search address: "Celestica Electronics (S) Pte Ltd" -> "celestica-electronics-s-pte-ltd". */
function slugOf(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** Normalised name for matching: case, punctuation, "(S)"/"(M)" markers and legal form removed. */
function normName(name) {
  return name
    .toLowerCase()
    .replace(/\((s|m)\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORM.has(w))
    .join(' ');
}

/** Decode the \uXXXX and \/ escapes used inside the page's embedded JSON strings. */
function decodeJsonString(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
}

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const kw = String(keyword || '').trim();
    const slug = slugOf(kw);
    const wanted = normName(kw);
    if (!slug || !wanted) {
      return answer('couldnt_check', 'other', [], '', 'the name has no letters the site search address can use');
    }

    searchUrl = `https://www.foundit.my/search/${encodeURIComponent(slug)}-jobs`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return answer('couldnt_check', 'blocked', [], searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return answer('couldnt_check', 'http_error', [], searchUrl, `HTTP ${res.status}`);
    }

    const html = await res.text();
    if (/Access Denied|errors\.edgesuite\.net/i.test(html) && !html.includes('companyName')) {
      return answer('couldnt_check', 'blocked', [], searchUrl, 'bot-protection page returned instead of results');
    }

    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
    if (!/Jobs in Malaysia/i.test(title)) {
      return answer('couldnt_check', 'layout_changed', [], searchUrl, title || html.slice(0, 300));
    }

    // Employer names are embedded in the page's JSON as \"companyName\":\"...\" (one per job card).
    const spellings = new Map(); // normalised name -> Set of spellings as the site writes them
    for (const m of html.matchAll(/\\"companyName\\":\\"(.*?)\\"/g)) {
      const raw = decodeJsonString(m[1]).trim();
      const key = normName(raw);
      if (!key) continue;
      if (!spellings.has(key)) spellings.set(key, new Set());
      spellings.get(key).add(raw);
    }
    if (spellings.size === 0) {
      return answer('couldnt_check', 'layout_changed', [], searchUrl, 'results page has no employer names in the expected form');
    }

    const hit = spellings.get(wanted);
    if (!hit) {
      return answer(
        'not_found',
        '',
        [],
        searchUrl,
        `No employer named "${kw}" on the first results page (${spellings.size} other employers shown)`,
      );
    }

    const records = [...hit].map((name) => ({ name, search_url: searchUrl }));
    return answer('found', '', records, searchUrl, `Employer "${records[0].name}" has job listings on foundit.my`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer(
      'couldnt_check',
      timeout ? 'timeout' : 'other',
      [],
      searchUrl,
      String(err?.message || err).slice(0, 300),
    );
  }
}
