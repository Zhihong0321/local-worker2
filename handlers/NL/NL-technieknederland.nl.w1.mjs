export const meta = { task: 'NL-technieknederland.nl', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'id', 'alt_name', 'address', 'website', 'quality_registrations', 'rating', 'review_count', 'review_url'],
  canary: { found: 'Brabant Installatie Techniek B.V.', not_found: 'Onbestaand Loodgietersbedrijf Zzqx B.V.' } };

// The public member search page (https://www.technieknederland.nl/ledenzoek-resultaat) draws its results from two
// JSON feeds on leden.technieknederland.nl. The page's own script sends this app token with every feed request;
// it is a public client-side identifier, not a login or a secret.
const BASE = 'https://leden.technieknederland.nl/cms/modules/Uneto/ledenzoek2020/';
const TOKEN = '0622D836-AA7B-4B50-AB1B-8D29BED1A103';
const SEARCH_PAGE = 'https://www.technieknederland.nl/ledenzoek-resultaat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// A feed with fewer members than this is treated as a changed layout, not as "nobody is listed".
const MIN_MEMBERS = 100;

const LEGAL_FORM = /\b(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?)(?=\s|$)/g;

/** Compare-only form of a name: lower case, no accents, no punctuation, no Dutch legal form (BV, NV, VOF, CV). */
function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' ')
    .replace(LEGAL_FORM, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function splitIds(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** One GET of a feed. Returns { json } or { fail, detail }. Never throws. */
async function getFeed(name) {
  const res = await fetch(BASE + name + '?token=' + TOKEN, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status} from ${name}` };
  if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status} from ${name}` };
  const text = await res.text();
  try {
    return { json: JSON.parse(text) };
  } catch {
    if (/captcha|cf-chl|challenge-platform|access denied/i.test(text.slice(0, 5000))) {
      return { fail: 'blocked', detail: `bot check page from ${name}` };
    }
    return { fail: 'layout_changed', detail: `${name} did not return JSON: ${text.slice(0, 200)}` };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = SEARCH_PAGE;
  try {
    const kwNorm = normalize(keyword);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'keyword has no letters or digits' };
    }

    const [details, filters] = await Promise.all([getFeed('GetDetails.aspx'), getFeed('GetInfoForFiltering.aspx')]);
    if (details.fail) {
      return { status: 'couldnt_check', reason: details.fail, records: [], source_url: sourceUrl, excerpt: details.detail };
    }

    const list = details.json?.data?.CompanyDetails;
    if (!Array.isArray(list) || list.length < MIN_MEMBERS) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl,
               excerpt: `member feed has no usable CompanyDetails list (${Array.isArray(list) ? list.length : 'not a list'})` };
    }

    // Quality registration names are optional: if the filter feed fails, the records keep the numeric ids.
    const qualNames = new Map();
    const qualities = filters.json?.data?.Kwaliteitsregelingen;
    if (Array.isArray(qualities)) {
      for (const q of qualities) qualNames.set(String(q.Id), clean(q.Name));
    }

    const matches = list.filter((c) => normalize(c.Name) === kwNorm || (c.AltName && normalize(c.AltName) === kwNorm));
    const records = matches.map((c) => ({
      name: clean(c.Name),
      id: c.Id,
      alt_name: clean(c.AltName),
      address: clean(c['Loc.']),
      website: clean(c.Site),
      quality_registrations: splitIds(c.Kwaliteitreg).map((id) => qualNames.get(id) || id),
      rating: c.Rate ?? null,
      review_count: c.RateAmount ?? null,
      review_url: c.RateUrl || null,
    }));

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: sourceUrl,
               excerpt: `0 matching members among ${list.length} listed on the public member search` };
    }
    return { status: 'found', reason: '', records, source_url: sourceUrl,
             excerpt: `${records.length} matching listing(s) among ${list.length} members on the public member search` };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: sourceUrl,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
