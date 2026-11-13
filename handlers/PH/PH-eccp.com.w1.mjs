export const meta = {
  task: 'PH-eccp.com',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_type', 'member_since', 'industries', 'profile_url'],
  canary: { found: 'Roche (Philippines) Inc.', not_found: 'Kumpanyang Hindi Umiiral Kailanman' },
};

// The ECCP member directory (https://www.eccp.com/members-directory) is public. Its search box is an
// AJAX POST to the same page; the answer is JSON whose "memdirectory::directory" value is an HTML partial.
// The search returns at most 10 entries and has no further pages, so an empty result is only proof of
// absence when fewer than 10 entries came back.
const DIRECTORY_URL = 'https://www.eccp.com/members-directory';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RESULT_CAP = 10;
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'opc', 'pte', 'llc', 'bhd', 'sdn', 'the', 'plc', 'gmbh']);

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, accents, punctuation and legal form removed. */
function normName(s) {
  return cleanText(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL_FORMS.has(w)).join('');
}

/** The typed name without its legal-form words, for a second, shorter search. */
function bareName(s) {
  return String(s).trim().split(/\s+/)
    .filter((w) => !LEGAL_FORMS.has(w.toLowerCase().replace(/[^a-z]/g, ''))).join(' ');
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** One result card per company: name, profile link, membership type, year, industries. */
function parseCards(partial) {
  const heads = [...partial.matchAll(/<h2 class="eccp-section-caption-title[^"]*"><a href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>/g)];
  return heads.map((m, i) => {
    const start = m.index;
    const end = i + 1 < heads.length ? heads[i + 1].index : partial.length;
    const seg = partial.slice(start, end);
    const t = partial.lastIndexOf('data-memtype="', start);
    const memtype = t >= 0 ? decode(partial.slice(t + 14, partial.indexOf('"', t + 14))) : '';
    const since = seg.match(/Member since:\s*([^<]*)</i);
    const inds = seg.match(/Industries:\s*([^<]*)</i);
    return {
      name: cleanText(m[2]),
      profile_url: new URL(decode(m[1]), DIRECTORY_URL).href,
      membership_type: memtype,
      member_since: since ? cleanText(since[1]) : '',
      industries: inds ? cleanText(inds[1]) : '',
    };
  });
}

/** Runs one directory search. Returns { cards } or { failure } (a couldnt_check answer). */
async function runSearch(term) {
  let res;
  let text;
  try {
    res = await fetch(DIRECTORY_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-OCTOBER-REQUEST-HANDLER': 'memdirectory::onUpdateList',
        'X-OCTOBER-REQUEST-PARTIALS': 'memdirectory::directory',
      },
      body: new URLSearchParams({ search: term, country: '', industry: '' }).toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { failure: couldnt('blocked', DIRECTORY_URL, `HTTP ${res.status}`) };
    if (!res.ok) return { failure: couldnt('http_error', DIRECTORY_URL, `HTTP ${res.status}`) };
    text = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { failure: couldnt(timedOut ? 'timeout' : 'other', DIRECTORY_URL, String(e?.message || e)) };
  }

  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const partial = data && typeof data['memdirectory::directory'] === 'string' ? data['memdirectory::directory'] : null;
  if (partial === null) {
    const challenge = /captcha|cf-chl|challenge-platform|Attention Required|are you a robot/i.test(text);
    return { failure: couldnt(challenge ? 'blocked' : 'layout_changed', DIRECTORY_URL, text.slice(0, 300)) };
  }
  // The search form must still be there; a page without it is not the directory any more.
  if (!/name="search"/.test(partial)) return { failure: couldnt('layout_changed', DIRECTORY_URL, partial.slice(0, 300)) };
  return { cards: parseCards(partial) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const typed = String(keyword ?? '').trim();
  if (!typed) return couldnt('other', DIRECTORY_URL, 'empty company name');
  try {
    const target = normName(typed);
    if (!target) return couldnt('other', DIRECTORY_URL, 'name has no letters or digits to compare');

    const first = await runSearch(typed);
    if (first.failure) return first.failure;
    let cards = first.cards;
    let matches = cards.filter((c) => normName(c.name) === target);
    let searched = typed;

    // Search capped and no exact hit: try again with the name without its legal form.
    const bare = bareName(typed);
    if (!matches.length && cards.length >= RESULT_CAP && bare && bare !== typed) {
      const second = await runSearch(bare);
      if (second.failure) return second.failure;
      searched = bare;
      cards = second.cards;
      matches = cards.filter((c) => normName(c.name) === target);
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(({ name, membership_type, member_since, industries, profile_url }) =>
          ({ name, membership_type, member_since, industries, profile_url })),
        source_url: matches[0].profile_url,
        excerpt: `Directory search "${searched}": ${matches.map((m) => m.name).join('; ')}`.slice(0, 500),
      };
    }

    if (cards.length >= RESULT_CAP) {
      return couldnt('other', DIRECTORY_URL,
        `Directory search "${searched}" returned the site's maximum of ${RESULT_CAP} entries and none is this company; the list cannot be read further`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: `Directory search "${searched}" returned ${cards.length} entries, none of them this company`,
    };
  } catch (err) {
    return couldnt('other', DIRECTORY_URL, String(err?.message || err));
  }
}
