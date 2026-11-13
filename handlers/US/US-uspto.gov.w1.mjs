export const meta = { task: 'US-uspto.gov', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'owner_type', 'owner_location', 'mark', 'serial_number', 'registration_number', 'status', 'filed_date', 'registration_date'],
  canary: { found: 'Apple Inc.', not_found: 'Zqxjvkw Plumbrix Holdings LLC' } };

// The search page https://www.uspto.gov/trademarks/search links to the trademark search app at tmsearch.uspto.gov.
// That app's anonymous search is one JSON POST to this Elasticsearch endpoint (no login, no token, no captcha).
const API = 'https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'lp', 'llp',
  'plc', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'pty', 'pte', 'sdn', 'bhd']);
const MAX_RECORDS = 200;
const MAX_SCAN = 500;

/** Lower-case words with accents, punctuation and spacing removed. */
function words(str) {
  return String(str || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Same as words(), without trailing legal-form words (INC, LLC, SDN BHD ...). */
function coreWords(str) {
  const w = words(str);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w;
}

/** "Apple Inc. (CORPORATION; USA)" -> { name: "Apple Inc.", type: "CORPORATION", location: "USA" } */
function ownerParts(entry) {
  const s = String(entry || '');
  const m = s.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  const [type = '', location = ''] = m ? m[2].split(';').map((x) => x.trim()) : [];
  return { name: (m ? m[1] : s).trim(), type, location };
}

function fail(reason, excerpt, source_url = API) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** One search. Returns { hits, total } or { fail } with the reason. */
async function runSearch(phrase) {
  const body = {
    query: { bool: { must: [{ query_string: { query: `ownerName:"${phrase}"`, default_operator: 'AND' } }] } },
    size: MAX_SCAN,
    track_total_hits: true,
    _source: ['id', 'wordmark', 'markName', 'ownerName', 'statusCode', 'statusDescription', 'filedDate', 'registrationDate', 'registrationId'],
  };
  let res;
  let text;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { fail: fail(timeout ? 'timeout' : 'other', 'search request failed: ' + (e?.message || e)) };
  }
  if (res.status === 403 || res.status === 429 || res.headers.get('x-amzn-waf-action') || /awswaf|captcha/i.test(text.slice(0, 2000))) {
    return { fail: fail('blocked', `HTTP ${res.status} from the search API (bot check or refusal)`) };
  }
  if (!res.ok) return { fail: fail('http_error', `HTTP ${res.status}`) };
  let json;
  try { json = JSON.parse(text); } catch { return { fail: fail('layout_changed', text.slice(0, 200)) }; }
  if (!json || !json.hits || !Array.isArray(json.hits.hits)) return { fail: fail('layout_changed', text.slice(0, 200)) };
  return { hits: json.hits.hits, total: Number(json.hits.totalValue ?? json.hits.total?.value ?? 0) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const full = words(keyword).join(' ');
    const core = coreWords(keyword).join(' ');
    if (!full) return fail('other', 'empty company name');

    // First the name as typed (legal form included), then the name without its legal form.
    const phrases = [...new Set([full, core])];
    let matches = [];
    let total = 0;
    let scanned = 0;
    let queried = '';
    for (const phrase of phrases) {
      const r = await runSearch(phrase);
      if (r.fail) return r.fail;
      queried = phrase;
      total = r.total;
      scanned = r.hits.length;
      matches = [];
      const seen = new Set();
      for (const hit of r.hits) {
        const src = hit.source || {};
        for (const entry of [].concat(src.ownerName || [])) {
          const p = ownerParts(entry);
          if (coreWords(p.name).join(' ') !== core) continue;
          const key = `${hit.id}|${p.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({
            name: p.name,
            owner_type: p.type,
            owner_location: p.location,
            mark: src.wordmark || src.markName || '',
            serial_number: String(src.id || hit.id || ''),
            registration_number: src.registrationId ? String(src.registrationId) : '',
            status: src.statusDescription || String(src.statusCode || ''),
            filed_date: src.filedDate || '',
            registration_date: src.registrationDate || '',
          });
        }
      }
      if (matches.length) break;
    }

    const scope = `${scanned} of ${total} hits checked for owner "${queried}"`;
    if (!matches.length) {
      return { status: 'not_found', reason: '', records: [], source_url: API, excerpt: `0 trademark owners match "${keyword}" (${scope})` };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.slice(0, MAX_RECORDS),
      source_url: API,
      excerpt: `${matches.length} trademark record(s) owned by "${matches[0].name}" (${scope})`,
    };
  } catch (err) {
    return fail('other', String(err?.message || err));
  }
}
