export const meta = {
  task: 'GB-fdf.org.uk',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'letter', 'matched_on'],
  canary: { found: 'Quaker Oats Ltd', not_found: 'Zorblax Vintners Ltd' },
};

// The FDF members list is one public HTML page: an A-Z list of "manufacturing and association" member names,
// one <p> per name. Professional affiliates are on separate pages and are NOT searched here.
const LIST_URL = 'https://www.fdf.org.uk/fdf/about-fdf/members-list/';
const LIST_NAME = 'Manufacturing and association members';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'inc', 'gmbh', 'sa', 'sas', 'bv', 'nv', 'ag']);
const ENTITIES = new Map([
  ['amp', '&'], ['nbsp', ' '], ['quot', '"'], ['apos', "'"], ['lt', '<'], ['gt', '>'],
  ['rsquo', "'"], ['lsquo', "'"], ['ldquo', '"'], ['rdquo', '"'], ['ndash', '-'], ['mdash', '-'],
]);
// A real list has about 500 names; anything far below this means the page is not the list we expect.
const MIN_ENTRIES = 50;

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES.get(e.toLowerCase()) ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare key: lower case, punctuation removed, trailing legal form removed, leading "the" removed. */
function normalise(name) {
  const words = decode(name).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join('');
}

/** The listed name, plus any "(formerly X)" name the site gives for the same company. */
function aliasesOf(raw) {
  const out = [{ text: raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim(), via: 'name' }];
  for (const m of raw.matchAll(/\(formerly\s+([^)]+)\)/gi)) out.push({ text: m[1].trim(), via: 'former name' });
  return out;
}

/** Returns [{name, letter}] for every member name in the list, or null if the list is not there. */
function parseList(html) {
  const startM = /<a[^>]*\bid="a"/i.exec(html);
  const endIdx = html.search(/<\/main>/i);
  if (!startM || endIdx < 0 || endIdx <= startM.index) return null;
  const body = html.slice(startM.index, endIdx);
  const entries = [];
  let letter = '';
  const re = /<h[23][^>]*>\s*<a[^>]*\bid="([a-z])"[^>]*>|<p>([^<]*)<\/p>/gi;
  for (const m of body.matchAll(re)) {
    if (m[1]) {
      letter = m[1].toUpperCase();
    } else {
      const name = decode(m[2]);
      if (name && !/^if your company/i.test(name)) entries.push({ name, letter });
    }
  }
  return entries;
}

function couldnt(reason, excerpt, source_url = LIST_URL) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await checkList(keyword);
  // On Windows Node, exiting right after a fetch can crash while the socket closes (seen in try.mjs runs).
  // A short pause lets the socket close first; the answer itself is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function checkList(keyword) {
  try {
    const want = normalise(keyword);
    if (!want) return couldnt('other', 'empty company name');

    const res = await fetch(LIST_URL, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, res.url || LIST_URL);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, res.url || LIST_URL);
    if (/\/sign-in/i.test(new URL(res.url || LIST_URL).pathname)) {
      return couldnt('blocked', 'redirected to the sign-in page (login wall)', res.url);
    }

    const html = await res.text();
    const entries = parseList(html);
    const hasHeading = /Manufacturing and association members/i.test(html);
    if (!entries || entries.length < MIN_ENTRIES || !hasHeading) {
      if (/captcha|cf-chl|challenge-platform|Just a moment/i.test(html) && (!entries || entries.length === 0)) {
        return couldnt('blocked', 'bot check page instead of the members list', res.url || LIST_URL);
      }
      return couldnt('layout_changed', `members list not found (names parsed: ${entries ? entries.length : 0})`,
        res.url || LIST_URL);
    }

    const records = [];
    for (const e of entries) {
      const hit = aliasesOf(e.name).find((a) => normalise(a.text) === want);
      if (hit) records.push({ name: e.name, list: LIST_NAME, letter: e.letter, matched_on: hit.via });
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: LIST_URL,
        excerpt: `On the FDF ${LIST_NAME} list: ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt: `No match for "${keyword}" on the FDF ${LIST_NAME} list (${entries.length} names checked). ` +
        'Professional affiliates are not on this list.',
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
