export const meta = {
  task: 'IN-voxya.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'id', 'profile_url'],
  canary: { found: 'Myntra', not_found: 'Vrindavan Kalpataru Udyog' },
};

const BASE = 'https://app.voxya.com';
const SITE = 'https://voxya.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Legal-form words that are only stripped from the END of a name (e.g. "ACME PVT LTD" -> "ACME").
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'opc', 'inc', 'llc', 'corp', 'corporation', 'pvtltd', 'privatelimited']);

function tokens(str) {
  return String(str || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Name without trailing legal form, as plain words (keeps the original spelling for the search). */
function coreWords(str) {
  const words = String(str || '').trim().split(/\s+/).filter(Boolean);
  while (words.length && LEGAL.has(tokens(words[words.length - 1]).join(''))) words.pop();
  return words.join(' ');
}

/** Comparison key: lower case, punctuation and spaces removed, trailing legal form removed. */
function key(str) {
  const t = tokens(str);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join('');
}

function slugOf(name) {
  const s = String(name || '').trim().replace(/\s+/g, '-').toLowerCase();
  return /^[a-z0-9-]+$/.test(s) ? s : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword ?? '').trim();
  try {
    const wanted = key(input);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'the name has no company words' };
    }
    const query = coreWords(input) || input;
    const url = `${BASE}/getCompany/${encodeURIComponent(query)}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      // e.g. HTTP 500 for non-Latin input: the site failed, it did not say "not listed"
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const body = await res.text();
    const trimmed = body.trim();
    if (!trimmed.startsWith('[')) {
      const lower = trimmed.toLowerCase();
      const reason = lower.includes('captcha') || lower.includes('challenge') ? 'blocked' : 'layout_changed';
      return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: trimmed.slice(0, 300) };
    }

    let entries;
    try {
      entries = JSON.parse(trimmed);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: trimmed.slice(0, 300) };
    }
    if (!Array.isArray(entries) || (entries.length && (typeof entries[0]?.name !== 'string' || entries[0]?.id === undefined))) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: trimmed.slice(0, 300) };
    }

    const matches = entries.filter((e) => e && typeof e.name === 'string' && key(e.name) === wanted);
    if (!matches.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: url,
        excerpt: `${entries.length} search results for "${query}", none with the same name`,
      };
    }

    const records = matches.map((e) => {
      const name = e.name.trim();
      const slug = slugOf(name);
      return {
        name,
        id: e.id,
        profile_url: slug ? `${SITE}/company/${slug}-complaints/${e.id}` : '',
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: JSON.stringify(records).slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: `${BASE}/getCompany/`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
