export const meta = { task: 'ID-siapkerja.kemnaker.go.id', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'wlkp_code', 'key', 'status', 'verified', 'address', 'website', 'region', 'industry', 'ebursa_registered'],
  canary: { found: 'PT. Antika Sanjaya', not_found: 'PT Tidak Terdaftar Nusantara Sejahtera' } };

// SIAPkerja (Kemnaker) company directory: a public JSON search used by the site's own front end.
const API = 'https://api.kemnaker.go.id/karirhub/v1/available-companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 6;             // at most 6 x 50 results per search
const SOFT_DEADLINE_MS = 30000;  // do not start a new request after 30 s (each request has its own 25 s limit)
// Legal-form words that are ignored when comparing names (Indonesian and a few foreign forms).
const LEGAL = new Set(['pt', 'cv', 'ud', 'tbk', 'persero', 'perum', 'sdn', 'bhd', 'ltd', 'limited', 'pte', 'llc', 'inc']);

function coreTokens(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL.has(w));
}

function coreName(s) {
  return coreTokens(s).join(' ');
}

// The site name, plus any legal name written in brackets, e.g. "Hotel X (PT. Y)".
function candidateNames(site) {
  const out = [coreName(site)];
  for (const m of String(site || '').matchAll(/\(([^)]*)\)/g)) out.push(coreName(m[1]));
  return out.filter(Boolean);
}

// The user's name with only the legal-form words removed, original spelling kept (used as the search text).
function stripLegalRaw(s) {
  return String(s || '').split(/\s+/).filter((w) => {
    const k = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    return k && !LEGAL.has(k);
  }).join(' ');
}

function toRecord(d) {
  const e = d.employer || {};
  const o = e.employerable || {};
  return {
    name: o.name || d.name || '',
    wlkp_code: o.wlkp_code || '',
    key: o.key || d.key || '',
    status: e.status || '',
    verified: typeof e.verified === 'boolean' ? e.verified : null,
    address: o.address || '',
    website: o.website || '',
    region: (d.region && d.region.name) || '',
    industry: (d.industry && d.industry.name) || '',
    ebursa_registered: typeof d.ebursa_registered === 'boolean' ? d.ebursa_registered : null,
  };
}

function urlFor(query, page) {
  return `${API}?keyword=${encodeURIComponent(query)}&page=${page}`;
}

async function fetchPage(query, page) {
  const url = urlFor(query, page);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: { reason: timeout ? 'timeout' : 'other', url, excerpt: String(err && err.message || err).slice(0, 300) } };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return { fail: { reason: 'blocked', url, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { reason: 'http_error', url, excerpt: `HTTP ${res.status}` } };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  const pag = json && (json.pagination || (json.meta && json.meta.pagination));
  if (!json || !Array.isArray(json.data) || !pag || !pag.last_page) {
    return { fail: { reason: 'layout_changed', url, excerpt: text.slice(0, 300) } };
  }
  return { data: json.data, lastPage: Number(pag.last_page) || 1, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const out = (status, reason, records, source_url, excerpt) => ({ status, reason, records, source_url, excerpt });
  try {
    const kwCore = coreName(keyword);
    if (!kwCore) {
      return out('couldnt_check', 'other', [], urlFor(String(keyword || ''), 1), 'no company name left after removing the legal form');
    }
    // Two searches: the name as typed (legal form removed), then its longest word. The site's search matches
    // substrings, so the second one still finds the company when punctuation differs (e.g. "ABC-XYZ" vs "ABC XYZ").
    const longest = coreTokens(keyword).reduce((a, b) => (b.length > a.length ? b : a), '');
    const queries = [...new Set([stripLegalRaw(keyword), longest].filter(Boolean))];

    const matches = [];
    let matchUrl = '';
    let lastUrl = urlFor(queries[0], 1);
    let truncated = false;

    for (const q of queries) {
      let page = 1;
      let lastPage = 1;
      while (page <= lastPage && page <= MAX_PAGES) {
        if (Date.now() - started > SOFT_DEADLINE_MS) {
          return out('couldnt_check', 'timeout', [], lastUrl, `stopped after ${Math.round((Date.now() - started) / 1000)} s with the search not fully read`);
        }
        const r = await fetchPage(q, page);
        if (r.fail) return out('couldnt_check', r.fail.reason, [], r.fail.url, r.fail.excerpt);
        lastUrl = r.url;
        lastPage = r.lastPage;
        for (const d of r.data) {
          const rec = toRecord(d);
          if (candidateNames(rec.name).includes(kwCore)) {
            matches.push(rec);
            if (!matchUrl) matchUrl = r.url;
          }
        }
        page++;
      }
      if (lastPage >= page) truncated = true; // pages were left unread
      if (matches.length) break;
    }

    if (matches.length) {
      const seen = new Set();
      const records = matches.filter((r) => {
        const id = r.key + '|' + r.wlkp_code;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return out('found', '', records, matchUrl, `${records.length} matching record(s); first: ${JSON.stringify(records[0]).slice(0, 400)}`);
    }

    if (truncated) {
      return out('couldnt_check', 'other', [], lastUrl, `search for "${kwCore}" has more pages than were read (first ${MAX_PAGES} x 50 results); no match in them`);
    }
    return out('not_found', '', [], lastUrl, `0 matching companies for "${kwCore}" (searched: ${queries.map((q) => `"${q}"`).join(', ')})`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], urlFor(String(keyword || ''), 1), String(err && err.message || err).slice(0, 300));
  }
}
