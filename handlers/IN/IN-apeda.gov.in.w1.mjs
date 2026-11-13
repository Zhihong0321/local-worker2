export const meta = { task: 'IN-apeda.gov.in', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['source', 'name', 'rcmc_no', 'certificate_no', 'address', 'city', 'state', 'pin', 'exporter_type', 'exporter_status',
    'certificate_issued', 'certificate_valid_until', 'product_scope', 'export_market'],
  canary: { found: 'MGS GRAPES PRIVATE LIMITED', not_found: 'अस्तित्वहीन पैकहाउस कंपनी' } };

// Two APEDA company registers, both public and without a captcha in the request:
//  - Exporter's Directory (RCMC holders). The site needs one state per search, so every state is searched.
//  - Recognized Packhouses (active packhouse certificates), searched by name.
// The "Exporter Status" check on apeda.gov.in is behind a captcha and is NOT used here.
const BASE = 'https://traceability.apeda.gov.in/apedamobile/api/apedaWebsite/';
const EXPORTER_PAGE = 'https://apeda.gov.in/exporter-directory';
const PACKHOUSE_PAGE = 'https://apeda.gov.in/recognized-packhouses';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const STATE_START_LIMIT_MS = 30000; // no new state search starts after 30 s, so the whole call stays under 60 s
const PARALLEL = 8;

// Legal-form words dropped before names are compared (Indian and common forms).
const LEGAL_WORDS = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company',
  'corp', 'corporation', 'opc', 'plc', 'pte', 'sdn', 'bhd']);

class Fail extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

/** Lower-case words of a name; punctuation (and Devanagari matras, which are marks) separate words. */
function words(str) {
  return String(str || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** The name without legal-form words, as one normalised string. Used for the exact match. */
function coreName(str) {
  const w = words(str);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] === 'p' && w[i + 1] === 'ltd') continue; // "P.LTD." -> "p ltd"
    if (LEGAL_WORDS.has(w[i])) continue;
    out.push(w[i]);
  }
  return out.join(' ');
}

/** The typed name with its legal-form chunks removed, punctuation kept (the site searches by substring). */
function searchPhrase(str) {
  return String(str || '').trim().split(/\s+/).filter(chunk => {
    const w = words(chunk);
    if (w.length === 0) return false;
    const legal = w.every(x => LEGAL_WORDS.has(x) || x === 'p' || x === 'ltd');
    return !(legal && w.some(x => LEGAL_WORDS.has(x)));
  }).join(' ');
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Fail('layout_changed', text.slice(0, 150)); }
  if (!json || !Array.isArray(json.table)) throw new Fail('layout_changed', text.slice(0, 150));
  return json.table;
}

function failOf(err, source) {
  const reason = err instanceof Fail ? err.reason
    : (err?.name === 'TimeoutError' || err?.name === 'AbortError') ? 'timeout' : 'other';
  return { reason, detail: `${source}: ${String(err?.message || err).slice(0, 180)}` };
}

/** Runs fn over items with at most `limit` in flight. Errors are returned as { error } so one failure does not stop the rest. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { value: await fn(items[i]) }; } catch (error) { out[i] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Exporter's Directory: search every state by name. Returns { matches, fail }; fail is set if any part could not be checked. */
async function exporterSearch(phrase, target, startedAt) {
  let states;
  try {
    states = await post(BASE + 'ExporterDirectory_state', { qType: '7' });
  } catch (err) {
    return { matches: [], fail: failOf(err, 'exporter directory') };
  }
  const codes = states.map(s => s.code).filter(Boolean);
  if (codes.length === 0) return { matches: [], fail: { reason: 'layout_changed', detail: 'exporter directory: empty state list' } };

  const results = await mapPool(codes, PARALLEL, async code => {
    if (Date.now() - startedAt > STATE_START_LIMIT_MS) throw new Fail('timeout', 'not started before the 30 s limit');
    return post(BASE + 'ExporterDirectory_AllResult', { qType: '13', expName: phrase, expState: code, expType: 'ALL', expProduct: '0000' });
  });

  const matches = [];
  const seen = new Set();
  let fail = null;
  for (const r of results) {
    if (r.error) { fail = fail || failOf(r.error, 'exporter directory'); continue; }
    for (const row of r.value) {
      const key = row.rcmcno || `${row.exporter_name}|${row.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (coreName(row.exporter_name) === target) {
        matches.push({
          source: 'exporter_directory',
          name: String(row.exporter_name || '').trim(),
          rcmc_no: String(row.rcmcno || '').trim(),
          address: String(row.address || '').trim(),
          city: String(row.city || '').trim(),
          state: String(row.state || '').trim(),
          pin: String(row.pin || '').trim(),
          exporter_type: String(row.expType || '').trim(),
          exporter_status: String(row.expStatus || '').trim(),
        });
      }
    }
  }
  return { matches, fail };
}

/** Recognized Packhouses: active packhouse certificates, searched by name. */
async function packhouseSearch(phrase, target) {
  try {
    const rows = await post(BASE + 'PhViewActiveReport_activePackHolderList', { qType: '117', phName: phrase, phStateCode: '', product: '' });
    const matches = [];
    const seen = new Set();
    for (const row of rows) {
      const key = row.certificateNo || `${row.phName}|${row.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (coreName(row.phName) === target) {
        matches.push({
          source: 'recognized_packhouse',
          name: String(row.phName || '').trim(),
          certificate_no: String(row.certificateNo || '').trim(),
          state: String(row.stateName || '').trim(),
          address: String(row.address || '').trim(),
          certificate_issued: String(row.certificateIssueDate || '').trim(),
          certificate_valid_until: String(row.certificateValidUpTo || '').trim(),
          product_scope: String(row.productScope || '').trim(),
          export_market: String(row.exportMarket || '').trim(),
        });
      }
    }
    return { matches, fail: null };
  } catch (err) {
    return { matches: [], fail: failOf(err, 'packhouse list') };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // Short pause so the sockets fetch just used finish closing before the worker process exits.
  // Without it, Node on Windows can abort at exit (libuv assertion, exit code 127) after printing the answer.
  await new Promise(resolve => setTimeout(resolve, 300));
  return result;
}

async function lookupOnce(keyword) {
  const startedAt = Date.now();
  try {
    const input = String(keyword || '').trim();
    const target = coreName(input);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: EXPORTER_PAGE,
        excerpt: 'no company name left after removing the legal form' };
    }
    const phrase = searchPhrase(input) || input;

    const [exp, ph] = await Promise.all([exporterSearch(phrase, target, startedAt), packhouseSearch(phrase, target)]);
    const records = [...exp.matches, ...ph.matches];

    if (records.length > 0) {
      const summary = records.map(r => r.source === 'exporter_directory'
        ? `Exporter's Directory: ${r.name} (RCMC ${r.rcmc_no}, ${r.state})`
        : `Recognized Packhouse: ${r.name} (${r.certificate_no})`).join('; ');
      return {
        status: 'found', reason: '', records,
        source_url: exp.matches.length ? EXPORTER_PAGE : PACKHOUSE_PAGE,
        excerpt: summary.slice(0, 500),
      };
    }

    const fail = exp.fail || ph.fail;
    if (fail) {
      return { status: 'couldnt_check', reason: fail.reason, records: [], source_url: EXPORTER_PAGE, excerpt: fail.detail.slice(0, 300) };
    }

    return {
      status: 'not_found', reason: '', records: [], source_url: EXPORTER_PAGE,
      excerpt: `No match for "${input}" in APEDA's Exporter's Directory (all states) or the Recognized Packhouse list.`,
    };
  } catch (err) {
    const f = failOf(err, 'handler');
    return { status: 'couldnt_check', reason: f.reason, records: [], source_url: EXPORTER_PAGE, excerpt: f.detail.slice(0, 300) };
  }
}
