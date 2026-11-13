export const meta = {
  task: 'ID-afpi.or.id',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'member_id', 'profile_url', 'founded', 'ceo', 'address', 'phone', 'email', 'profile_read', 'match'],
  canary: { found: 'Amartha', not_found: 'PT Sejahtera Tanpa Batas Makmur' },
};

// AFPI publishes its P2P lending members as brand names (platform_name), not legal names.
// The members list is read from the site's own JSON endpoint (27 per page, 94 in total), then matched locally.
const BASE = 'https://afpi.or.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json, text/html;q=0.9, */*;q=0.8' };
const LEGAL_FORMS = new Set(['pt', 'tbk', 'persero', 'cv', 'ltd', 'limited', 'pte', 'sdn', 'bhd', 'llc', 'inc', 'corp', 'co', 'pvt']);
const MAX_PAGES = 20;
const DEADLINE_MS = 40000; // keep well under the 60 s limit

function coreWords(str) {
  return String(str || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL_FORMS.has(w));
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

// Raw inner HTML of the <p> that follows an <h5>label</h5> on a profile page.
function labelRaw(html, label) {
  const re = new RegExp(`<h5[^>]*>\\s*${label}\\s*:?\\s*</h5>\\s*<p[^>]*>([\\s\\S]*?)</p>`, 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

// 'exact' = same name once legal form and punctuation are removed; 'brand_in_name' = the brand is a whole-word run
// inside the typed name (e.g. "Amartha" inside "PT Amartha Mikro Fintek"). The site does not show legal names,
// so the second kind is not enough to say "found".
function matchKind(keyword, brand) {
  const k = coreWords(keyword);
  const b = coreWords(brand);
  if (!k.length || !b.length) return null;
  if (k.join('') === b.join('')) return 'exact';
  if (b.join('').length >= 4) {
    for (let i = 0; i + b.length <= k.length; i++) {
      if (b.every((w, j) => k[i + j] === w)) return 'brand_in_name';
    }
  }
  return null;
}

async function readProfile(profileUrl, started) {
  if (Date.now() - started > 45000) return { profile_read: false };
  try {
    const res = await fetch(profileUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { profile_read: false };
    const html = await res.text();
    if (!/Tentang Perusahaan/i.test(html)) return { profile_read: false };
    return {
      profile_read: true,
      founded: clean(labelRaw(html, 'Didirikan')),
      ceo: clean(labelRaw(html, 'CEO')),
      phone: clean(labelRaw(html, 'Hubungi Kami')),
      email: clean(labelRaw(html, 'Email Kami')),
      address: clean(labelRaw(html, 'Alamat').split('<div')[0]),
    };
  } catch {
    return { profile_read: false };
  }
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const listUrl = `${BASE}/members`;
  const pageUrl = (page) => `${BASE}/frontend/members_data?page=${page}&category=&sort=&keyword=`;
  try {
    // 1. Read the whole member list, one page at a time (page 0 is the first 27 members).
    const members = [];
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) return couldnt('other', pageUrl(page), `member list has more than ${MAX_PAGES} pages`);
      if (Date.now() - started > DEADLINE_MS) return couldnt('timeout', pageUrl(page), 'member list read ran out of time');
      const res = await fetch(pageUrl(page), { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', pageUrl(page), `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', pageUrl(page), `HTTP ${res.status}`);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return couldnt('layout_changed', pageUrl(page), text); }
      if (!json || typeof json !== 'object' || !('members' in json)) return couldnt('layout_changed', pageUrl(page), text);
      if (!Array.isArray(json.members) || json.members.length === 0) break;
      members.push(...json.members);
    }
    if (members.length === 0) return couldnt('layout_changed', pageUrl(0), 'member list came back empty');

    // 2. Match the typed name against the brand names.
    const exact = [];
    const partial = [];
    for (const m of members) {
      const brand = String(m.platform_name || '').trim();
      const kind = matchKind(keyword, brand);
      if (kind === 'exact') exact.push({ m, brand, kind });
      else if (kind === 'brand_in_name') partial.push({ m, brand, kind });
    }

    if (exact.length > 0) {
      // 3. Found: read each matching profile page for its details (best effort).
      const records = [];
      for (const { m, brand, kind } of exact) {
        const profileUrl = `${BASE}/profilemember/${encodeURIComponent(String(m.platform_name).replaceAll(' ', '-'))}`;
        const details = await readProfile(profileUrl, started);
        records.push({ name: brand, member_id: String(m.id ?? ''), profile_url: profileUrl, match: kind, ...details });
      }
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].profile_url,
        excerpt: `Listed on the AFPI members page as "${records[0].name}" (member ${records[0].member_id}) of ${members.length} members.`,
      };
    }

    if (partial.length > 0) {
      // Not confirmed: the site shows brand names only, so the typed legal name cannot be tied to them from the site.
      const names = partial.map((p) => `"${p.brand}"`).join(', ');
      return couldnt('other', listUrl, `Possible brand match ${names} for "${keyword}", but the site shows brand names only, so this is not confirmed.`);
    }

    // 4. Not found: the list was read in full and nothing matches.
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: listUrl,
      excerpt: `None of the ${members.length} listed AFPI members match "${keyword}".`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', listUrl, String(err?.message || err));
  }
}
