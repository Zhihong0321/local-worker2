export const meta = {
  task: 'CH-sqs.ch',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'certificate_number', 'standard', 'address', 'zip_code', 'city', 'suspended'],
  canary: { found: 'Swisscom (Schweiz) AG', not_found: 'Nichtexistierende Muster Firma AG' },
};

// SQS certificate search (https://www.sqs.ch/de/zertifizierte-organisationen). The page's own script does:
//   1. GET https://www.sqs.ch/rest/verify          -> {"access":true}   (the site refuses to search when access is false)
//   2. GET https://database.iqnet-certification.com/rest/search?title=<name>&page=<n>
//      -> {"results":[...], "count":"<total certificates>"}, 51 results per page, substring match on the organisation name.
// This handler does the same two steps, reads every page, and keeps only entries whose organisation name matches the
// keyword after normalisation (case, accents, punctuation, legal form, "und"/"&").

const SITE = 'https://www.sqs.ch';
const API = 'https://database.iqnet-certification.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_CAP = 10;          // 10 pages x 51 results = 510 certificates per search term, more than enough for one company
const DEADLINE_MS = 40000;    // whole call must finish in under 60 s

// Legal forms and connecting words that are ignored when comparing names (both sides are normalised the same way).
const NOISE = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'corp', 'kg', 'co', 'sas', 'srl', 'spa',
  'bv', 'nv', 'rl', 'aktiengesellschaft', 'gesellschaft', 'haftung', 'beschrankter', 'anonyme', 'limitee', 'societe',
  'cie', 'und', 'et', 'and']);

/** Normalised name for comparison: lower case, no accents or punctuation, no legal form. */
function core(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((t) => t && !NOISE.has(t)).join(' ');
}

/** The keyword without trailing legal-form words, punctuation kept, so the site's substring search can match. */
function searchTerm(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  while (words.length && core(words[words.length - 1].replace(/\./g, '')) === '') words.pop();
  return words.join(' ');
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}

/** Organisation name as the site writes it: the text before the first <br> (the rest is the seat). */
function orgName(item) {
  return decode(String(item.organisation || '').split(/<br\s*\/?>/i)[0]);
}

const fetchOpts = (accept) => ({
  headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8' },
  signal: AbortSignal.timeout(25000),
});

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Walks every result page of one search term. Returns {items, count, complete, fail}. */
async function searchAll(term, startedAt) {
  const items = [];
  let count = null;
  for (let page = 0; page < PAGE_CAP; page++) {
    if (Date.now() - startedAt > DEADLINE_MS) return { items, count, complete: false, fail: couldnt('timeout', `${SITE}/de/zertifizierte-organisationen`, 'search did not finish in time') };
    const url = `${API}/rest/search?title=${encodeURIComponent(term)}&page=${page}`;
    let res;
    try {
      res = await fetch(url, fetchOpts('application/json'));
    } catch (e) {
      const reason = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
      return { items, count, complete: false, fail: couldnt(reason, url, String(e?.message || e)) };
    }
    if (res.status === 403 || res.status === 429) return { items, count, complete: false, fail: couldnt('blocked', url, `HTTP ${res.status}`) };
    if (!res.ok) return { items, count, complete: false, fail: couldnt('http_error', url, `HTTP ${res.status}`) };

    let j;
    try { j = JSON.parse(await res.text()); } catch { return { items, count, complete: false, fail: couldnt('layout_changed', url, 'search answer is not JSON') }; }
    const total = j && j.count !== undefined ? parseInt(j.count, 10) : NaN;
    if (!j || !Array.isArray(j.results) || Number.isNaN(total)) {
      return { items, count, complete: false, fail: couldnt('layout_changed', url, JSON.stringify(j).slice(0, 300)) };
    }
    if (count === null) count = total;
    items.push(...j.results);
    if (items.length >= count) return { items, count, complete: true, fail: null };
    if (j.results.length === 0) return { items, count, complete: false, fail: null }; // total says more, page is empty
  }
  return { items, count, complete: false, fail: null };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startedAt = Date.now();
  const kw = String(keyword || '').trim();
  const pageUrl = `${SITE}/de/zertifizierte-organisationen?title=${encodeURIComponent(kw)}`;
  try {
    if (!core(kw)) return couldnt('other', pageUrl, 'empty company name');

    // Step 1: the site's own access check, which its search script runs before every search.
    const verifyUrl = `${SITE}/rest/verify`;
    const v = await fetch(verifyUrl, fetchOpts('application/json'));
    if (v.status === 403 || v.status === 429) return couldnt('blocked', pageUrl, `${verifyUrl} HTTP ${v.status}`);
    if (!v.ok) return couldnt('http_error', pageUrl, `${verifyUrl} HTTP ${v.status}`);
    let vj;
    try { vj = JSON.parse(await v.text()); } catch { return couldnt('layout_changed', pageUrl, 'verify answer is not JSON'); }
    if (vj && vj.access === false) return couldnt('blocked', pageUrl, 'site access check returned {"access":false}');
    if (!vj || vj.access !== true) return couldnt('layout_changed', pageUrl, JSON.stringify(vj).slice(0, 300));

    // Step 2: search. Try the keyword without legal form first, then the normalised words, then the keyword as typed.
    const target = core(kw);
    const terms = [...new Set([searchTerm(kw), target, kw].filter((t) => t && core(t)))];
    let anyIncomplete = false;
    let lastCount = 0;
    let lastTerm = terms[0];

    for (const term of terms) {
      const r = await searchAll(term, startedAt);
      if (r.fail) return r.fail;
      lastTerm = term;
      lastCount = r.count || 0;
      const matches = r.items.filter((it) => core(orgName(it)) === target);
      if (matches.length) {
        const seenIds = new Set();
        const records = [];
        for (const it of matches) {
          if (seenIds.has(it.id)) continue;
          seenIds.add(it.id);
          records.push({
            name: orgName(it),
            certificate_number: decode(it.certificate_number),
            standard: decode(it.name),
            address: decode(it.field_address),
            zip_code: decode(it.field_zip_code),
            city: decode(it.field_city),
            suspended: String(it.suspended) === '1',
          });
        }
        const list = records.map((x) => `${x.standard} (${x.certificate_number})`).join('; ');
        return {
          status: 'found',
          reason: '',
          records,
          source_url: pageUrl,
          excerpt: `${records[0].name}: ${list}`.slice(0, 300),
        };
      }
      if (!r.complete) anyIncomplete = true;
    }

    if (anyIncomplete) return couldnt('other', pageUrl, `search for "${lastTerm}" was not read to the end`);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `Site search returned ${lastCount} certificate(s) for "${lastTerm}", none for this company name.`,
    };
  } catch (err) {
    return couldnt('other', pageUrl, String(err?.message || err));
  }
}
