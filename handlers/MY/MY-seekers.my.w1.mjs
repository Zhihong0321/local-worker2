export const meta = {
  task: 'MY-seekers.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'reg_no', 'slug', 'address', 'post_code', 'city', 'state', 'industry', 'size', 'company_url'],
  canary: { found: 'Boost Holdings Sdn Bhd', not_found: 'Syarikat Tiada Rekod Sdn Bhd' },
};

// The company directory on seekers.my reads its companies from this public JSON collection (no login).
const API = 'https://directus.seekers.my/items/companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;
const MAX_PAGES = 5; // at most 500 name matches are read; more than that is couldnt_check, never not_found
const LEGAL_FORMS = new Set(['sdn', 'bhd', 'berhad', 'sendirian']);
const FIELDS = ['name', 'reg_no', 'slug', 'address', 'post_code', 'city', 'state', 'industry', 'size', 'company_url'];

/** Split a name into lower-case words, dropping punctuation and legal-form words (Sdn Bhd, Berhad). */
function words(str, dropParens = false) {
  let s = String(str || '').normalize('NFKC');
  if (dropParens) s = s.replace(/\([^)]*\)/g, ' ');
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL_FORMS.has(w));
}

/** Keys used to compare names: the whole name, and the name without bracketed text. */
function keysOf(name) {
  const keys = new Set([words(name).join(''), words(name, true).join('')]);
  keys.delete('');
  return keys;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let firstUrl = '';
  try {
    const termWords = words(keyword);
    if (termWords.length === 0) {
      return couldnt('other', '', `no name left to search after removing the legal form from "${keyword}"`);
    }
    const term = termWords.join(' ');
    const wanted = keysOf(keyword);
    const matches = [];
    let total = null;
    let read = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        'filter[name][_icontains]': term,
        fields: FIELDS.join(','),
        meta: 'filter_count',
        sort: 'name',
        limit: String(PAGE),
        offset: String(page * PAGE),
      });
      const url = `${API}?${params.toString()}`;
      if (!firstUrl) firstUrl = url;

      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return couldnt('blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return couldnt('http_error', url, `HTTP ${res.status}`);
      }

      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return couldnt('layout_changed', url, text.slice(0, 200));
      }
      if (!body || !Array.isArray(body.data) || typeof body.meta?.filter_count !== 'number') {
        return couldnt('layout_changed', url, JSON.stringify(body).slice(0, 200));
      }

      total = body.meta.filter_count;
      read += body.data.length;
      for (const rec of body.data) {
        if (!rec || typeof rec.name !== 'string') continue;
        const keys = keysOf(rec.name);
        if ([...keys].some((k) => wanted.has(k))) matches.push(rec);
      }
      if (matches.length > 0 || read >= total || body.data.length === 0) break;
    }

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.name,
          reg_no: r.reg_no ?? null,
          slug: r.slug ?? null,
          address: r.address ?? null,
          post_code: r.post_code ?? null,
          city: r.city ?? null,
          state: r.state ?? null,
          industry: r.industry ?? null,
          size: r.size ?? null,
          company_url: r.company_url ?? null,
        })),
        source_url: firstUrl,
        excerpt: matches.map((r) => `${r.name} | reg ${r.reg_no ?? '-'} | ${r.address ?? '-'}`).join(' ; ').slice(0, 300),
      };
    }

    if (read < total) {
      return couldnt('other', firstUrl, `${total} directory names contain "${term}", only ${read} were read; exact match not checked for all`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 directory names match "${keyword}" (${total} names contain "${term}")`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
