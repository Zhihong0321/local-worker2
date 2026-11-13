export const meta = { task: 'SG-trust.stb.gov.sg', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'record_id', 'record_url'],
  canary: { found: 'Times Express Pte Ltd', not_found: 'Syarikat Lawatan Tiada Rekod Sdn Bhd' } };

// The TRUST site publishes its business-licence records as public sitemap files (static lists of record URLs).
// The record pages themselves are rendered by JavaScript, so this handler only reads the list: a name match means
// the record is listed on the site. Status, licence number and address are not visible without JavaScript.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LISTS = [
  'https://trust.stb.gov.sg/s/sitemap-businesslicense-1.xml',
  'https://trust.stb.gov.sg/s/sitemap-businesslicense-weekly.xml',
];
const LEGAL_FORMS = new Set(['pte', 'ltd', 'limited', 'pvt', 'private', 'sdn', 'bhd', 'llp', 'llc', 'inc', 'company']);
const RECORD_RE = /<loc>\s*(https:\/\/trust\.stb\.gov\.sg\/s\/businesslicence\/([A-Za-z0-9]{15,18})\/([^<\s]+?))\s*<\/loc>/g;

/** Comparable form of a company name: case, accents, punctuation and legal form removed. */
function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
}

function slugToName(slug) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch { /* keep raw slug */ }
  return s.replace(/-+/g, ' ').trim();
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source_url = LISTS[0];
  try {
    const kw = norm(keyword);
    if (!kw) return failure('other', source_url, 'the keyword has no name characters');

    const seen = new Set();
    const matches = [];
    let total = 0;

    for (const url of LISTS) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return failure('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return failure('http_error', url, `HTTP ${res.status}`);

      const xml = await res.text();
      if (!xml.includes('<urlset')) return failure('layout_changed', url, xml.slice(0, 300));

      for (const m of xml.matchAll(RECORD_RE)) {
        total++;
        const [, record_url, record_id, slug] = m;
        if (seen.has(record_id)) continue;
        seen.add(record_id);
        const name = slugToName(slug);
        if (norm(name) === kw) {
          matches.push({ name, record_id, record_url });
        }
      }
    }

    // The main list must hold the bulk of the records; a small or odd file means the site changed.
    if (total < 1000) return failure('layout_changed', source_url, `only ${total} record links found`);

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url,
        excerpt: `0 of ${seen.size} listed business-licence records match "${keyword}"`,
      };
    }
    return {
      status: 'found', reason: '', records: matches, source_url,
      excerpt: matches.map((r) => r.record_url).join(' | ').slice(0, 300),
    };
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return failure('timeout', source_url, 'the list did not load in 25 s');
    return failure('other', source_url, String(err?.message || err));
  }
}
