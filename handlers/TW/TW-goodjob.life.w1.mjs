export const meta = { task: 'TW-goodjob.life', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'business_number', 'data_count', 'page_url'],
  canary: { found: '台灣電力股份有限公司', not_found: '零零零測試不存在股份有限公司' } };

// GoodJob's site search is a GraphQL call (search_companies) that the front end sends to api.goodjob.life.
// It matches the START of the stored name, so the handler searches twice: with the name as typed, and with the
// legal form removed (for example "良豐不銹鋼管件股份有限公司" returns nothing, but "良豐不銹鋼管件" finds the company).
const API = 'https://api.goodjob.life/graphql';
const SITE = 'https://www.goodjob.life';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIMIT = 500;
const QUERY = 'query($companyName: String!, $hasData: Boolean!, $limit: Int) { search_companies(query: $companyName, hasData: $hasData, limit: $limit) { name businessNumber dataCount } }';

const ZH_FORMS = ['股份有限公司', '有限責任公司', '有限公司', '公司', '企業社'];
const EN_FORMS = new Set(['co', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'company', 'llc', 'plc', 'sdn', 'bhd', 'pte', 'gmbh']);

class Fail extends Error {
  constructor(reason, message) { super(message); this.reason = reason; this.name = 'Fail'; }
}

const nfkc = (s) => String(s ?? '').normalize('NFKC');

/** The name without its legal form, keeping the original text (used as the search prefix). */
function stripLegalForms(raw) {
  let t = nfkc(raw).trim();
  let changed = true;
  while (changed) {
    changed = false;
    t = t.replace(/[\s\p{P}]+$/u, '');
    for (const f of ZH_FORMS) {
      if (t.length > f.length && t.endsWith(f)) { t = t.slice(0, -f.length); changed = true; break; }
    }
    if (!changed) {
      const m = t.match(/(?:^|\s)([A-Za-z]+)$/);
      if (m && t.length > m[1].length && EN_FORMS.has(m[1].toLowerCase())) { t = t.slice(0, -m[1].length); changed = true; }
    }
  }
  return t.trim() || nfkc(raw).trim();
}

/** Comparison key: case, punctuation, spaces and legal form removed. */
function normalizeCore(s) {
  const t = nfkc(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  let joined = t.split(' ').filter((w) => w && !EN_FORMS.has(w)).join('');
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of ZH_FORMS) {
      if (joined.length > f.length && joined.endsWith(f)) { joined = joined.slice(0, -f.length); changed = true; break; }
    }
  }
  return joined;
}

/** Names a stored record answers to: the full name, its bracketed aliases, and its Chinese and Latin parts. */
function candidateNames(name) {
  const base = nfkc(name).replace(/\s*\(\s*\d{6,10}\s*\)\s*$/, '').trim();
  const aliases = [...base.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const main = base.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [main, ...aliases];
  const latinAt = main.search(/[A-Za-z]/);
  if (latinAt > 0) out.push(main.slice(0, latinAt).trim(), main.slice(latinAt).trim());
  return out.filter(Boolean);
}

async function search(query) {
  const res = await fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(25000),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': SITE,
      'Referer': `${SITE}/`,
    },
    body: JSON.stringify({ query: QUERY, variables: { companyName: query, hasData: false, limit: LIMIT } }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const challenge = /captcha|challenge|cf-chl|turnstile|just a moment/i.test(text);
    throw new Fail(challenge ? 'blocked' : 'layout_changed', text.slice(0, 300));
  }
  if (json.errors && !json.data) throw new Fail('other', 'GraphQL error: ' + JSON.stringify(json.errors).slice(0, 250));
  const rows = json?.data?.search_companies;
  if (!Array.isArray(rows)) throw new Fail('layout_changed', 'no search_companies list in: ' + text.slice(0, 200));
  return { rows, truncated: rows.length >= LIMIT };
}

function toFailure(err) {
  const reason = err instanceof Fail ? err.reason
    : (err?.name === 'TimeoutError' || err?.name === 'AbortError') ? 'timeout' : 'other';
  return { status: 'couldnt_check', reason, records: [], source_url: API, excerpt: String(err?.message || err).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const raw = nfkc(keyword).trim();
    const core = normalizeCore(raw);
    if (!raw || !core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty company name' };
    }
    const queries = [...new Set([raw, stripLegalForms(raw)])];
    // One request at a time: parallel sockets trip a Node-on-Windows exit assertion (exit code 127).
    const outcomes = [];
    for (const q of queries) {
      try { outcomes.push({ ok: true, value: await search(q) }); } catch (err) { outcomes.push({ ok: false, err }); }
    }

    const matches = [];
    const seen = new Set();
    let failure = null;
    let truncated = false;
    let rowsSeen = 0;
    for (const o of outcomes) {
      if (!o.ok) { failure ||= toFailure(o.err); continue; }
      truncated ||= o.value.truncated;
      rowsSeen += o.value.rows.length;
      for (const row of o.value.rows) {
        const name = nfkc(row?.name ?? '').trim();
        if (!name) continue;
        if (!candidateNames(name).some((c) => normalizeCore(c) === core)) continue;
        const bizNo = row.businessNumber ? String(row.businessNumber) : null;
        const key = `${name}|${bizNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const base = name.replace(/\s*\(\s*\d{6,10}\s*\)\s*$/, '').trim();
        matches.push({
          name,
          business_number: bizNo,
          data_count: typeof row.dataCount === 'number' ? row.dataCount : null,
          page_url: `${SITE}/companies/${encodeURIComponent(base)}`,
        });
      }
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matches[0].page_url,
        excerpt: `${matches.length} match(es): ` + matches.map((m) => m.name).join('; ').slice(0, 300),
      };
    }
    if (failure) return failure;
    if (truncated) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API,
        excerpt: `search returned ${LIMIT} rows and none matched; the company may be past the limit` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: API,
      excerpt: `GoodJob search for "${raw}" (also "${queries[1]}") returned ${rowsSeen} rows, none with this name` };
  } catch (err) {
    return toFailure(err);
  }
}
