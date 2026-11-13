export const meta = {
  task: 'SG-eurocham.org.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_id', 'website', 'phone', 'address', 'description'],
  canary: { found: 'BMW Asia Pte Ltd', not_found: '新加坡鸿运贸易私人有限公司' },
};

// The members page (https://eurocham.org.sg/membership/our-members/) loads its whole list from this JSON endpoint.
const LIST_URL = 'https://eurocham.org.sg/wp-json/pp-eurocham/v1/members';
const PAGE_URL = 'https://eurocham.org.sg/membership/our-members/';
// A Safari-style browser user-agent. Windows-Chrome strings get their connection reset by this server (tested 2026-11-13).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Legal-form words, removed only from the END of a name so "Pte Ltd" and "Pte. Ltd." compare equal.
const LEGAL_TAIL = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'sdn', 'bhd', 'berhad', 'llp', 'llc', 'inc',
  'incorporated', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'ag', 'bv', 'sa', 'nv', 'branch']);

/** Plain normalised form: case, punctuation and spacing removed, "&" read as "and". */
function plain(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Normalised name without the legal form at the end (e.g. "BMW Asia Pte Ltd" -> "bmw asia"). */
function core(name) {
  let s = plain(name).replace(/\bsingapore branch\b/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = s ? s.split(' ') : [];
  while (parts.length > 1 && LEGAL_TAIL.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', LIST_URL, 'empty company name');

    let res;
    try {
      res = await fetch(LIST_URL, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': PAGE_URL,
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return fail(timedOut ? 'timeout' : 'other', LIST_URL, e?.cause?.code || e?.message || e);
    }

    if (res.status === 403 || res.status === 429) return fail('blocked', LIST_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', LIST_URL, `HTTP ${res.status}`);

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!Array.isArray(data)) {
      const wall = /captcha|cf-chl|challenge-platform|access denied/i.test(text.slice(0, 5000));
      return fail(wall ? 'blocked' : 'layout_changed', LIST_URL, text.slice(0, 300));
    }

    const members = data.filter((m) => m && typeof m.company === 'string' && m.company.trim());
    if (!members.length) return fail('layout_changed', LIST_URL, 'member list came back with no company entries');

    // Match the company, not similar words: equal normalised names only (no substring match).
    const wantFull = plain(name);
    const wantCore = core(name);
    if (!wantCore) return fail('other', LIST_URL, `keyword has no usable letters: ${name}`);

    const seen = new Set();
    const hits = [];
    for (const m of members) {
      const key = String(m.id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (plain(m.company) === wantFull || core(m.company) === wantCore) hits.push(m);
    }

    if (!hits.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `Checked ${seen.size} EuroCham member entries; none is named "${name}"`,
      };
    }

    const records = hits.map((m) => ({
      name: m.company.trim(),
      member_id: m.id ?? null,
      website: m.website || '',
      phone: m.phone || '',
      address: m.address || '',
      description: clean(m.summary).slice(0, 600),
    }));

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `${first.name} | ${first.address} | ${first.website}`.slice(0, 500),
    };
  } catch (err) {
    return fail('other', LIST_URL, err?.message || err);
  }
}
