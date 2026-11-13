export const meta = {
  task: 'IE-ivca.ie',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership_category', 'membership_page'],
  canary: { found: 'Atlantic Bridge', not_found: 'Cuideachta Neamhliostaithe Teoranta' },
};

// The IVCA publishes its member firms as three plain HTML lists (no search, no login).
// A company is "found" when its normalised name equals a listed member's normalised name.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LISTS = [
  { category: 'Full Members', heading: 'Full Members', url: 'https://www.ivca.ie/about/full-members/' },
  { category: 'Affiliate Members', heading: 'Affiliate Members', url: 'https://www.ivca.ie/about/affiliate-members/' },
  { category: 'Associate Members', heading: 'Associate Members', url: 'https://www.ivca.ie/about/associate-members/' },
];

// Legal-form words dropped before comparing, so "Synova LLP" matches "Synova".
const LEGAL_FORMS = new Set(['ltd', 'limited', 'llp', 'plc', 'dac', 'teoranta', 'cuideachta', 'phriobhaideach', 'unlimited']);

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function normalize(str) {
  const words = decode(str)
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // fadas and other accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w));
  if (words[0] === 'the') words.shift();
  return words.join('');
}

/** Member names under the page's own <h1> heading (the menu and footer are skipped). */
function extractNames(html, heading) {
  const h1 = new RegExp(`<h1[^>]*>\\s*${heading}\\s*<\\/h1>`, 'i').exec(html);
  if (!h1) return null;
  let section = html.slice(h1.index + h1[0].length);
  const end = section.search(/IVCA Presentation Information|<footer/i);
  if (end > 0) section = section.slice(0, end);
  const names = [];
  for (const m of section.matchAll(/<h4[^>]*class="[^"]*ee-imagebox-title[^"]*"[^>]*>([\s\S]*?)<\/h4>/gi)) {
    const name = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (name) names.push(name);
  }
  return names;
}

async function fetchList(list) {
  try {
    const res = await fetch(list.url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { list, fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
    if (!res.ok) return { list, fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
    const html = await res.text();
    if (/cf-chl|captcha|Attention Required/i.test(html.slice(0, 5000))) {
      return { list, fail: { reason: 'blocked', excerpt: 'bot or captcha page' } };
    }
    const names = extractNames(html, list.heading);
    if (!names) return { list, fail: { reason: 'layout_changed', excerpt: `no "${list.heading}" heading` } };
    if (names.length === 0) return { list, fail: { reason: 'layout_changed', excerpt: 'no member names under heading' } };
    return { list, names };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { list, fail: { reason: timeout ? 'timeout' : 'other', excerpt: String((err && err.message) || err).slice(0, 200) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalize(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LISTS[0].url,
               excerpt: 'empty company name after removing punctuation and legal form' };
    }

    const results = await Promise.all(LISTS.map(fetchList));

    const records = [];
    for (const r of results) {
      if (!r.names) continue;
      for (const name of r.names) {
        if (normalize(name) === key) {
          records.push({ name, membership_category: r.list.category, membership_page: r.list.url });
        }
      }
    }
    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].membership_page,
        excerpt: `Listed on the IVCA ${records.map((x) => x.membership_category).join(', ')} page`,
      };
    }

    // No match. Only a clean answer from every list counts as not_found.
    const failed = results.filter((r) => r.fail);
    if (failed.length) {
      const pick = failed.find((r) => r.fail.reason === 'blocked') || failed[0];
      return {
        status: 'couldnt_check',
        reason: pick.fail.reason,
        records: [],
        source_url: pick.list.url,
        excerpt: failed.map((r) => `${r.list.url}: ${r.fail.reason} (${r.fail.excerpt})`).join(' | ').slice(0, 500),
      };
    }

    const total = results.reduce((n, r) => n + r.names.length, 0);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LISTS[0].url,
      excerpt: `Not among the ${total} names on the IVCA Full, Affiliate and Associate member pages`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LISTS[0].url,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
