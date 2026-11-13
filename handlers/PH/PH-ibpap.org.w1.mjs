export const meta = {
  task: 'PH-ibpap.org',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'address', 'city', 'trunkline', 'website', 'ibpap_member_id'],
  canary: { found: 'Concentrix CVG Philippines, Inc.', not_found: 'Kumpanyang Hindi Nakalista Inc.' },
};

// The members page (https://www.ibpap.org/members-list) renders this public JSON list: every IBPAP member, in one response.
const API_URL = 'https://www.ibpap.org/api/member-list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'opc', 'pte']);

/** "Concentrix CVG Philippines, Inc." -> "concentrixcvgphilippines" (case, accents, punctuation and legal form dropped). */
function normalize(str) {
  return String(str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

/** The ways a member is written: the full name, the name without its bracket, and the text inside the bracket. */
function nameKeys(name) {
  const text = String(name || '');
  const full = normalize(text);
  const outside = normalize(text.replace(/\([^)]*\)/g, ' '));
  const inside = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => normalize(m[1]));
  return new Set([full, outside, ...inside].filter(Boolean));
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const query = normalize(keyword);
    if (!query) return fail('other', API_URL, 'the company name is empty');

    const res = await fetch(API_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', API_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', API_URL, `HTTP ${res.status}`);

    const body = await res.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return fail('layout_changed', API_URL, 'response is not JSON: ' + body.slice(0, 200));
    }

    // An empty or missing list is a broken answer, not proof that the company is absent.
    const list = Array.isArray(data?.list) ? data.list : [];
    if (!list.some((m) => m && typeof m.name === 'string')) {
      return fail('layout_changed', API_URL, 'member list missing or empty; keys: ' + Object.keys(data || {}).join(','));
    }

    const matches = list.filter((m) => m && typeof m.name === 'string' && nameKeys(m.name).has(query));

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: API_URL,
        excerpt: `IBPAP member list has ${list.length} entries; none matches "${keyword}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({
        ibpap_member_id: m.id ?? null,
        name: m.name,
        category: m.category || '',
        address: m.address || '',
        city: m.city || '',
        trunkline: m.trunkline || '',
        website: m.link || '',
      })),
      source_url: API_URL,
      excerpt: ('IBPAP member list: ' + matches.map((m) => `${m.name} (${m.category || 'no category'})`).join('; ')).slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', API_URL, String(err?.message || err));
  }
}
