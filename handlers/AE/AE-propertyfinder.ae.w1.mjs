export const meta = { task: 'AE-propertyfinder.ae', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'id', 'url', 'license_label', 'license_number', 'address', 'phone', 'email', 'is_verified', 'total_properties', 'ranking'],
  canary: { found: 'Barnes International Realty', not_found: 'شركة زيد الوهمية للتجارة ذ.م.م' } };

// The site's own broker search (the page at /en/find-broker/search calls this JSON endpoint).
const API = 'https://www.propertyfinder.ae/api/pwa/brokerages';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const MAX_PAGES = 2; // 2 x 25 s fetch limit stays under the 60 s budget; more pages are reported as couldnt_check, never not_found
// Legal-form words, compared without punctuation. The site search returns nothing when "LLC" is in the query.
const LEGAL = new Set(['llc', 'fze', 'fzc', 'fzco', 'fzllc', 'dmcc', 'ltd', 'limited', 'pjsc', 'ذمم', 'شركة']);

/** Words of a company name with legal-form words removed. */
function splitWords(name) {
  return String(name || '')
    .replace(/\bL\.?\s*L\.?\s*C\.?(?=\s|$)/gi, ' ') // "L.L.C", "L L C" -> dropped
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !LEGAL.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
}

/** Comparison key: lower case, letters and digits only, legal form removed. */
function keyOf(name) {
  return splitWords(name).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join('');
}

function searchUrl(query, page) {
  const u = new URL(API);
  u.searchParams.set('text', query);
  u.searchParams.set('locale', 'en');
  u.searchParams.set('per_page', String(PAGE_SIZE));
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function toRecord(b) {
  return {
    name: b.name || '',
    id: b.id ?? null,
    url: b.urlSlug ? `https://www.propertyfinder.ae/en/broker/${b.urlSlug}` : '',
    license_label: b.licenseLabel || '',
    license_number: b.licenseNumber || '',
    address: b.address || '',
    phone: b.phone || '',
    email: b.email || '',
    is_verified: b.isVerified ?? null,
    total_properties: b.totalProperties ?? null,
    ranking: b.ranking ?? null,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '');
  const key = keyOf(input.replace(/&/g, ' '));
  const query = splitWords(input.replace(/&/g, ' ')).join(' ');
  const firstUrl = searchUrl(query, 1);

  if (!key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'no company name left to search after removing the legal form' };
  }

  try {
    const matches = [];
    let total = 0;
    let totalPages = 1;
    let pagesFetched = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = searchUrl(query, page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'locale': 'en' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || !Array.isArray(data.brokerages)) {
        const looksBlocked = /captcha|challenge|access denied|verify you are human|cloudflare/i.test(text.slice(0, 5000));
        return { status: 'couldnt_check', reason: looksBlocked ? 'blocked' : 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 300) };
      }

      pagesFetched = page;
      total = Number(data.meta?.total ?? data.brokerages.length);
      totalPages = Number(data.meta?.totalPages ?? 1);
      for (const b of data.brokerages) {
        if (keyOf(b.name) === key) matches.push(b);
      }
      if (page >= totalPages) break;
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map(toRecord),
        source_url: firstUrl,
        excerpt: matches.map((m) => `${m.name} | ${m.licenseLabel || ''} ${m.licenseNumber || ''} | ${m.address || ''}`).join(' ;; ').slice(0, 500),
      };
    }

    const seenAll = total === 0 || pagesFetched >= totalPages;
    if (!seenAll) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: firstUrl,
        excerpt: `site search "${query}" has ${total} results; only the first ${MAX_PAGES * PAGE_SIZE} were checked, no exact name match among them`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `site search "${query}" returned ${total} results, none named "${input}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
