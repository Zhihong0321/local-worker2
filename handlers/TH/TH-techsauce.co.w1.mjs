export const meta = {
  task: 'TH-techsauce.co',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'kind', 'category', 'status', 'total_raised', 'description', 'page_url'],
  canary: { found: 'Altotech co.,ltd', not_found: 'บริษัท ทดสอบ ไม่มีอยู่จริง จำกัด' },
};

// Techsauce Startup Directory (startupdirectory.techsauce.co) is a public list of startups and investors.
// Its own front end loads the two full lists below; the handler reads the same lists and matches the name.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://api-startupdirectory.techsauce.co';
const SITE = 'https://startupdirectory.techsauce.co';
const LISTS = [
  { kind: 'startup', path: '/api/startup/filter', page: '/startup/' },
  { kind: 'investor', path: '/api/investor/filter', page: '/investor/' },
];

// Legal-form words (English and Thai) that do not count when comparing names.
const LEGAL_WORDS = new Set(['co', 'company', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation',
  'plc', 'pcl', 'pte', 'llc', 'sdn', 'bhd', 'public', 'gmbh', 'ou', 'jsc']);

/** Normalised form of a company name: lower case, no legal form, no punctuation or spaces. */
function normalise(name) {
  const s = String(name || '').toLowerCase().replace(/ห้างหุ้นส่วน|บริษัท|จำกัด|มหาชน/g, ' ');
  // \p{M} keeps Thai vowel and tone marks inside words.
  return s.split(/[^\p{L}\p{N}\p{M}]+/u).filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/** Download one full list. Never throws: returns { items } or { error }. */
async function fetchList(list) {
  const url = API + list.path;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { error: { reason: 'blocked', url, excerpt: `${list.kind} list HTTP ${res.status}` } };
    }
    if (!res.ok) {
      return { error: { reason: 'http_error', url, excerpt: `${list.kind} list HTTP ${res.status}` } };
    }
    const text = await res.text();
    if (/captcha|just a moment|cf-challenge/i.test(text.slice(0, 2000))) {
      return { error: { reason: 'blocked', url, excerpt: `${list.kind} list returned a bot check` } };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { error: { reason: 'layout_changed', url, excerpt: `${list.kind} list is not JSON: ${text.slice(0, 200)}` } };
    }
    if (!body || !Array.isArray(body.data) || body.data.length === 0) {
      return { error: { reason: 'layout_changed', url, excerpt: `${list.kind} list has no data array` } };
    }
    return { items: body.data.filter((x) => typeof x?.attributes?.name === 'string') };
  } catch (err) {
    return {
      error: {
        reason: isTimeout(err) ? 'timeout' : 'other',
        url,
        excerpt: `${list.kind} list: ${String(err?.message || err).slice(0, 200)}`,
      },
    };
  }
}

function toRecord(item, list) {
  const a = item.attributes || {};
  const isStartup = list.kind === 'startup';
  const category = isStartup ? a.startupIndustry?.data?.attributes?.name : a.investorType?.data?.attributes?.name;
  const status = isStartup ? a.startupStatus?.data?.attributes?.name : a.investorStatus?.data?.attributes?.name;
  return {
    name: a.name,
    kind: list.kind,
    category: category || null,
    status: status || null,
    total_raised: isStartup && a.discloseTotalRaised ? (a.totalRaised ?? null) : null,
    description: String(a.description || '').slice(0, 300),
    page_url: `${SITE}${list.page}${encodeURI(a.name)}`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalise(keyword);
    if (!kw) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: `${SITE}/`,
        excerpt: 'the name has no words left after removing the legal form',
      };
    }

    const results = await Promise.all(LISTS.map(fetchList));

    const records = [];
    let checked = 0;
    let failure = null;
    results.forEach((r, i) => {
      if (r.error) {
        failure = failure || r.error;
        return;
      }
      checked += r.items.length;
      for (const item of r.items) {
        if (normalise(item.attributes.name) === kw) records.push(toRecord(item, LISTS[i]));
      }
    });

    if (records.length) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: first.page_url,
        excerpt: `${first.name}: ${first.kind}, ${first.category ?? 'no category'}, ${first.status ?? 'no status'}`,
      };
    }

    if (failure) {
      return { status: 'couldnt_check', reason: failure.reason, records: [], source_url: failure.url, excerpt: failure.excerpt };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${SITE}/`,
      excerpt: `No match among ${checked} listed startups and investors`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `${SITE}/`,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
