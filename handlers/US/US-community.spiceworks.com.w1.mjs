export const meta = {
  task: 'US-community.spiceworks.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'topic_url', 'description', 'paid_vendor'],
  canary: { found: 'Rippling IT', not_found: 'Zorvantis Lumen Holdings' },
};

const SITE = 'https://community.spiceworks.com';
const SITE_JSON = `${SITE}/site.json`;
const VENDORS_PARENT_ID = 38; // the "Vendors" category; each vendor profile is a sub-category of it
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal forms, plus generic corporate words that the vendor profiles often add or drop ("Cisco" / "Cisco Systems, Inc.").
const TRAILING_WORDS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'lp', 'llp', 'pllc', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'pty',
  'systems', 'technologies', 'holdings', 'group', 'international']);

/** Lower-case, drop punctuation, read "&" as "and", drop a leading "The" and trailing legal-form words. */
function normalizeName(str) {
  let words = String(str || '')
    .toLowerCase()
    .replace(/&amp;|&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words[0] === 'the') words = words.slice(1);
  while (words.length > 1 && TRAILING_WORDS.has(words[words.length - 1])) words = words.slice(0, -1);
  return words.join('');
}

function cleanText(str) {
  return String(str || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

async function search(keyword) {
  try {
    const res = await fetch(SITE_JSON, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', SITE_JSON, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', SITE_JSON, `HTTP ${res.status}`);

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/captcha|challenge-platform|cf-chl|just a moment/i.test(text.slice(0, 5000))) {
        return fail('blocked', SITE_JSON, 'bot check page instead of JSON');
      }
      return fail('layout_changed', SITE_JSON, text.slice(0, 300));
    }

    const categories = data && Array.isArray(data.categories) ? data.categories : null;
    if (!categories) return fail('layout_changed', SITE_JSON, 'site.json has no categories list');

    const vendors = categories.filter((c) => c && c.parent_category_id === VENDORS_PARENT_ID);
    if (vendors.length === 0) return fail('layout_changed', SITE_JSON, 'no vendor profiles under the Vendors category');

    const want = normalizeName(keyword);
    if (!want) return fail('other', SITE_JSON, 'empty company name');

    const matches = vendors.filter((c) => normalizeName(c.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SITE_JSON,
        excerpt: `No vendor profile named "${keyword}" among ${vendors.length} Vendors profiles on the site`,
      };
    }

    const records = matches.map((c) => {
      const description = cleanText(c.description_text);
      return {
        name: c.name,
        url: `${SITE}/c/vendors/${c.slug}/${c.id}`,
        topic_url: c.topic_url ? `${SITE}${c.topic_url}` : '',
        description: description.slice(0, 500),
        paid_vendor: String(c.is_a_paid_vendor) === 'true',
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: SITE_JSON,
      excerpt: `${records[0].name}: ${records[0].description}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SITE_JSON, String(err && err.message ? err.message : err));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // On this Windows Node build the runner can exit while the last fetch socket is still closing (exit code 127).
  // A short pause after the last fetch lets the socket finish before the process ends.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}
