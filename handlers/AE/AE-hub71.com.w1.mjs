export const meta = {
  task: 'AE-hub71.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sector', 'stage', 'cohort', 'country', 'website', 'profile_url'],
  canary: { found: 'Lune Technologies', not_found: 'شركة الصحراء للتجارة' },
};

// Hub71's own startup directory calls this JSON endpoint on page load (search box = `search`).
const BASE = 'https://www.hub71.com/all-startups';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 500; // the whole directory (about 356 startups) fits in one page
const MAX_PAGES = 10;

// Legal forms removed from both sides before comparing names.
const ENGLISH_FORMS = new Set(['pte', 'ltd', 'limited', 'llc', 'fzllc', 'fze', 'fzco', 'fz', 'dmcc', 'inc', 'corp', 'corporation', 'sdn', 'bhd', 'plc', 'gmbh', 'llp']);
const ARABIC_FORMS = ['ش.ذ.م.م', 'ذ.م.م', 'ش.م.ع', 'شركة', 'ذ م م', 'ش ذ م م'];

/** Lower-case words of a company name with punctuation, '&' and legal forms removed. */
function words(name) {
  let s = (name || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/l\.\s*l\.\s*c\.?/g, 'llc');
  for (const f of ARABIC_FORMS) s = s.split(f).join(' ');
  return s
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !ENGLISH_FORMS.has(w));
}

/** The one string two names are compared by: all words joined, no spaces. */
function key(name) {
  return words(name).join('');
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Reason for a failed request, with the reason set by the task contract. */
function failure(err, url) {
  const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return {
    status: 'couldnt_check',
    reason: isTimeout ? 'timeout' : 'other',
    records: [],
    source_url: url,
    excerpt: String(err?.message || err).slice(0, 300),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = BASE;
  try {
    const w = words(keyword);
    if (w.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'no company name in the input' };
    }
    const wantKey = w.join('');

    // Search with the longest word, because the site matches substrings of its own text.
    // The exact comparison below decides the match.
    const term = w.reduce((best, x) => (x.length > best.length ? x : best), '');
    const searchUrl = (page) =>
      `${BASE}?search=${encodeURIComponent(term)}&page=${page}&perPage=${PER_PAGE}`;
    url = searchUrl(1);

    const getPage = async (page) => {
      const pageUrl = searchUrl(page);
      const res = await fetch(pageUrl, {
        headers: { 'user-agent': UA, accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` } };
      }
      if (!res.ok) {
        return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` } };
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!json || !Array.isArray(json.data) || typeof json.total !== 'number') {
        const blocked = /captcha|cf-chl|just a moment|access denied|verify you are human/i.test(text.slice(0, 5000));
        return {
          fail: {
            status: 'couldnt_check',
            reason: blocked ? 'blocked' : 'layout_changed',
            records: [],
            source_url: pageUrl,
            excerpt: cleanText(text).slice(0, 300),
          },
        };
      }
      return { json };
    };

    const first = await getPage(1);
    if (first.fail) return first.fail;
    const lastPage = Number(first.json.last_page) || 1;
    if (lastPage > MAX_PAGES) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: `${first.json.total} results, too many to check` };
    }
    const rest = [];
    for (let p = 2; p <= lastPage; p++) rest.push(getPage(p));
    const pages = [first, ...(await Promise.all(rest))];
    for (const p of pages) if (p.fail) return p.fail;

    const items = pages.flatMap((p) => p.json.data);
    const total = Number(first.json.total) || items.length;

    const matches = items.filter((item) => {
      const names = [item?.title?.en, item?.title?.ar].filter(Boolean);
      return names.some((n) => key(n) === wantKey);
    });

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `${total} result(s) for "${term}", none named like "${keyword}"`,
      };
    }

    const records = matches.map((item) => ({
      name: item.title?.en || item.title?.ar || '',
      sector: item.sector || '',
      stage: item.stage?.en || '',
      cohort: item.cohort || '',
      country: item.new_country || '',
      website: item.website || '',
      profile_url: item.link || '',
    }));
    const r = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: url,
      excerpt: cleanText(`${r.name}: sector ${r.sector}, stage ${r.stage}, cohort ${r.cohort}, ${r.profile_url}`).slice(0, 500),
    };
  } catch (err) {
    return failure(err, url);
  }
}
