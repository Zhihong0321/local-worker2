export const meta = {
  task: 'CH-northdata.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'registration_number', 'city', 'url'],
  canary: { found: 'Nestlé Capital Markets SA', not_found: 'Zyxqwvbn Nichtexistierende Firma GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words dropped before comparing names (after accents and dots are removed).
const LEGAL_FORMS = new Set(['sa', 'ag', 'gmbh', 'sarl', 'sagl', 'rl', 'ltd', 'limited', 'llc', 'inc', 'corp', 'plc', 'kg', 'ohg', 'co', 'bv', 'lp']);

/** Lower case, no accents, no dots or punctuation, no legal form: "Nestlé Ltd." and "NESTLE SA" both become "nestle". */
function normalizeName(str) {
  return String(str || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\./g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

/** Legal name and CHE number from a North Data company address such as ".../Nestlé SA, Vevey/CHE-105.909.036". */
function urlParts(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    const cut = path.lastIndexOf('/');
    const head = cut >= 0 ? path.slice(0, cut) : path;
    const id = cut >= 0 ? path.slice(cut + 1) : '';
    const comma = head.indexOf(', ');
    return {
      legal: (comma >= 0 ? head.slice(0, comma) : head).trim(),
      reg: /^CHE-[\d.]+$/.test(id) ? id : '',
    };
  } catch {
    return { legal: '', reg: '' };
  }
}

/** Every name a company result is known by: its display name, its "see:" alias and its legal name from the address. */
function candidateNames(r) {
  const names = [r.name, r.title];
  for (const part of String(r.title || '').split(/,\s*see:\s*/i)) names.push(part);
  names.push(urlParts(r.url).legal);
  return names.map(normalizeName).filter(Boolean);
}

function toRecord(r) {
  const parts = urlParts(r.url);
  return {
    name: r.name || r.title || '',
    legal_name: parts.legal,
    registration_number: parts.reg,
    city: String(r.description || '').split(',')[0].trim(),
    url: r.url || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows aborts (libuv assertion, exit 127) when the runner calls process.exit() while a fetch
  // socket is still closing. A short pause lets the socket close first; it costs 1.5 s and changes no answer.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return answer;
}

async function lookupOnce(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = `https://www.northdata.com/suggest.json?query=${encodeURIComponent(kw)}&countries=CH`;
  try {
    const kwNorm = normalizeName(kw);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.northdata.com/',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|too many requests|access denied/i.test(text.slice(0, 2000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: text.slice(0, 200) };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }
    if (!data || !Array.isArray(data.results)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: text.slice(0, 300) };
    }

    const matches = data.results.filter((r) => r && r.type === 'company' && candidateNames(r).includes(kwNorm));
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${data.results.length} suggestions returned, none is a company with this name`,
      };
    }

    const seen = new Set();
    const records = [];
    for (const r of matches) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      records.push(toRecord(r));
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: JSON.stringify(matches[0]).slice(0, 300),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
