export const meta = {
  task: 'IN-idma-assn.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'site_id'],
  canary: { found: 'PHARMEGIC HEALTHCARE PVT LTD', not_found: 'Zorvantra Biolabs Private Limited' },
};

// The site's member-login dropdown is filled by this public POST (no login needed). It lists the
// company names that have a member account with IDMA. The full members directory is behind login and a paid purchase.
const LIST_URL = 'https://idma-assn.org/jqry/companylist';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped before comparing, so "Pvt. Ltd." and "Private Limited" compare equal.
const LEGAL_WORDS = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'OPC', 'PLC']);

/** Upper-case, '&' -> AND, punctuation and spacing removed, legal-form words removed. */
function normalise(name) {
  const up = String(name || '').normalize('NFKC').toUpperCase().replace(/&/g, ' AND ');
  return up.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

/** True when the text has a letter outside the Latin script (e.g. Devanagari). The list is in English only. */
function hasNonLatinLetter(text) {
  return [...String(text || '')].some((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normalise(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'no company words in the input' };
    }
    if (hasNonLatinLetter(keyword)) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: LIST_URL,
        excerpt: 'the input is not in Latin script; the site lists company names in English only, so it cannot be matched',
      };
    }

    const res = await fetch(LIST_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: 'COUNTRYID=1',
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|cf-chl|just a moment/i.test(text.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot check page' };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: text.slice(0, 200) };
    }
    if (!json || json.status !== 'success' || !Array.isArray(json.data)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: text.slice(0, 200) };
    }

    const records = [];
    let named = 0;
    for (const row of json.data) {
      if (!row || typeof row.COMPANY_NAME !== 'string') continue;
      const listName = row.COMPANY_NAME.replace(/\s+/g, ' ').trim();
      if (!listName) continue;
      named++;
      // Exact match on the normalised name only: no substring matching.
      if (normalise(listName) === want) {
        records.push({ name: listName, site_id: String(row.ID ?? '') });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No match among ${named} company names on the IDMA member list`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `${records.length} matching entr${records.length === 1 ? 'y' : 'ies'} on the IDMA member list: ${records.map((r) => r.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
