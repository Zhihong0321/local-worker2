export const meta = {
  task: 'TH-atta.or.th',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'type', 'tat_id', 'mem_code', 'year_start', 'website', 'email', 'tel', 'market_inbound', 'market_outbound', 'branches'],
  canary: { found: 'TRAVEL 4 YOU CO.,LTD.', not_found: 'บริษัท ทดสอบไม่มีรายชื่อ จำกัด' },
};

// ATTA member directory (linked from https://www.atta.or.th/member-directory-2/ as an iframe).
// The directory page POSTs the search form to /member-directories and gets JSON back:
//   { count, members: [ [row, row, ...], ... ] }   one inner array per company
// searchType: ORDINARY = active members, ALLIED = the other member types.
const ENDPOINT = 'https://sp-wp-atta.dr.ns.co.th/member-directories';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TYPES = ['ORDINARY', 'ALLIED'];
// The host load-balances across nodes. A healthy node answers in about 0.3 s; a bad node answers 404 "Cannot POST"
// or hangs until its 25 s timeout. So each member type is asked by staggered attempts, and the first JSON answer wins.
const MAX_ATTEMPTS = 16;             // per member type
const HEDGE_EVERY_MS = 1200;        // while nothing has answered, start another attempt this often
const DEADLINE_MS = 45000;          // the whole call returns by then, well under the 60 s limit
const REASON_ORDER = ['blocked', 'layout_changed', 'http_error', 'timeout', 'other'];

// Strip a legal form from the start or end of a name (Thai and English), so "X CO.,LTD." and "X" compare equal.
const LEGAL_END = [
  /\s*\(มหาชน\)\s*$/u,
  /\s*มหาชน\s*$/u,
  /\s*จำกัด\s*$/u,
  /[\s,]*public\s+company\s+limited\.?\s*$/i,
  /[\s,]*company\s+limited\.?\s*$/i,
  /[\s,]*co\.?\s*,?\s*ltd\.?\s*$/i,
  /[\s,]*limited\.?\s*$/i,
  /[\s,]*(plc|pcl|inc|corp)\.?\s*$/i,
  /[\s,]*co\.?\s*$/i,
];
const LEGAL_START = [/^\s*บริษัท\s*/u];

/** The name without its legal form, whitespace collapsed. Used as the search text. */
function core(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = s;
    for (const re of LEGAL_START) s = s.replace(re, '');
    for (const re of LEGAL_END) s = s.replace(re, '');
    s = s.trim();
  } while (s !== prev);
  return s;
}

/** Comparison key: lower case, letters/digits/combining marks only. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

function toRecord(hit, rows, type) {
  const seen = new Set();
  const branches = [];
  for (const r of rows) {
    const address = [r.addr1, r.addr2, r.tambon, r.amphur, r.province, r.zipcode]
      .map((x) => String(x || '').trim()).filter(Boolean).join(' ');
    const key = `${r.name}|${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push({ branch: String(r.name || '').trim(), address });
  }
  return {
    name: String(hit.company_name || '').trim(),
    type,
    tat_id: hit.tat_id || '',
    mem_code: hit.mem_code || '',
    year_start: hit.year_start || '',
    website: hit.website || '',
    email: hit.email || '',
    tel: hit.tel || '',
    market_inbound: hit.market_inbound || '',
    market_outbound: hit.market_outbound || '',
    branches,
  };
}

/** One POST for one member type. Resolves { ok: true, members } or { ok: false, reason, excerpt }. Never rejects. */
async function attempt(query, type, abortSignal) {
  const body = new URLSearchParams({
    searchBy: '1', // Member Name
    searchType: type,
    searchInbound: '0',
    searchOutbound: '0',
    searchSpecialist: '0',
    searchKeyword: query,
    limit: '0',
    start: '0',
    init: '0',
  });
  const failed = (err) => {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: `${type}: ${String(err?.message || err).slice(0, 200)}` };
  };
  let res;
  let text;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      signal: AbortSignal.any([AbortSignal.timeout(25000), abortSignal]),
    });
    text = await res.text();
  } catch (err) {
    return failed(err);
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: 'blocked', excerpt: `${type}: HTTP ${res.status}` };
  }
  if (res.status !== 200) {
    return { ok: false, reason: 'http_error', excerpt: `${type}: HTTP ${res.status} ${text.slice(0, 80)}` };
  }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || !Array.isArray(data.members)) {
    return { ok: false, reason: 'layout_changed', excerpt: `${type}: 200 but not the member JSON: ${text.slice(0, 120)}` };
  }
  return { ok: true, members: data.members };
}

/** The most telling failure: blocked beats layout_changed beats http_error beats timeout beats other. */
function worst(failures) {
  for (const reason of REASON_ORDER) {
    const hit = failures.find((f) => f.reason === reason);
    if (hit) return hit;
  }
  return { reason: 'other', excerpt: 'no answer' };
}

/**
 * Ask one member type. While nothing has answered, a new attempt starts every HEDGE_EVERY_MS. Attempts run side by
 * side, each on its own connection, so the load balancer may pick a different node; a fast failure does not stop the
 * others. The first JSON answer wins. Resolves { ok: true, members } or { ok: false, reason, excerpt }.
 * Every attempt promise is put in `pending`, so the caller can wait for them after aborting.
 */
function searchType(query, type, ctl, pending) {
  return new Promise((resolve) => {
    let settled = false;
    let started = 0;
    const failures = [];
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(r);
    };
    const launch = () => {
      if (settled || ctl.signal.aborted || started >= MAX_ATTEMPTS) return;
      started++;
      const p = attempt(query, type, ctl.signal).then((r) => {
        if (settled) return;
        if (r.ok) return finish(r);
        failures.push(r);
        if (failures.length >= MAX_ATTEMPTS) finish({ ok: false, ...worst(failures) });
      });
      pending.add(p);
    };
    const timer = setInterval(launch, HEDGE_EVERY_MS);
    ctl.signal.addEventListener('abort', () => finish({ ok: false, reason: 'other', excerpt: `${type}: stopped` }), { once: true });
    launch();
  });
}

/** Resolve with a timeout failure if the search has not settled by the deadline. */
function withDeadline(promise, type) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      reason: 'timeout',
      excerpt: `${type}: no answer within ${DEADLINE_MS / 1000} s`,
    }), DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The lookup itself. Throws only on a bug; lookup() turns that into couldnt_check. */
async function search(keyword, ctl, pending) {
  const query = core(keyword) || String(keyword || '').trim();
  const want = normalize(core(keyword));
  if (!query || !want) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: ENDPOINT, excerpt: 'empty company name' };
  }

  // Both member types are asked at once. "Not listed" needs both to answer; one silent type is not "not listed".
  const results = await Promise.all(
    TYPES.map((type) => withDeadline(searchType(query, type, ctl, pending), type).then((r) => ({ type, r })))
  );

  const records = [];
  const seen = new Set();
  const failures = [];
  const answered = [];

  for (const { type, r } of results) {
    if (!r.ok) {
      failures.push(r);
      continue;
    }
    answered.push(type);
    for (const rows0 of r.members) {
      const rows = Array.isArray(rows0) ? rows0 : [rows0];
      const hit = rows.find((row) => normalize(core(row?.company_name)) === want);
      if (!hit) continue;
      const rec = toRecord(hit, rows, type);
      const key = `${type}|${rec.tat_id}|${rec.mem_code}|${rec.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }
  }

  if (records.length) {
    return {
      status: 'found',
      reason: '',
      records,
      source_url: ENDPOINT,
      excerpt: `${records.length} matching member record(s) for "${query}" (searched ${answered.join(' and ') || 'none'})`,
    };
  }
  if (failures.length) {
    // Cannot say "not listed" while a search did not answer: report why it could not be checked.
    return {
      status: 'couldnt_check',
      reason: worst(failures).reason,
      records: [],
      source_url: ENDPOINT,
      excerpt: failures.map((f) => f.excerpt).join(' | ').slice(0, 400),
    };
  }
  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: ENDPOINT,
    excerpt: `0 results for "${query}" in ${TYPES.join(' and ')}`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const ctl = new AbortController();
  const pending = new Set();
  try {
    return await search(keyword, ctl, pending);
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: ENDPOINT,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  } finally {
    // Stop the attempts still in flight and wait until their sockets are closed, so the process exits cleanly.
    ctl.abort();
    await Promise.allSettled([...pending]);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the closed sockets finish their own close events
  }
}
