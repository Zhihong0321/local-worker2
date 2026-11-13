export const meta = { task: 'MY-hiredly.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'register_name', 'slug', 'industry', 'profile_url'],
  canary: { found: 'ZUS COFFEE', not_found: 'Syarikat Tidak Wujud Sdn Bhd' } };

// Hiredly (Malaysia) keeps its company directory behind a public GraphQL endpoint that the company list page uses.
// The site's own search matches the brand name only, so a legal name ("Zuspresso (M) Sdn Bhd") can miss it. To stay
// correct, a name that the search does not match is checked against the whole list (502 companies, 21 per page),
// comparing both the brand name and the registered name.
const SITE = 'https://my.hiredly.com';
const ENDPOINT = 'https://my-api.hiredly.com/api/job_seeker/v1/graphql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_BUDGET_MS = 30000; // do not start a new page after this; each fetch is capped at 25 s, so the call ends under 60 s
const MAX_PAGES = 200;

const LEGAL = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'llp', 'plc', 'ltd', 'pte', 'inc']);

/** Normalised company name: case, punctuation and trailing legal form ignored, so "Zuspresso (M) Sdn. Bhd." == "zuspresso". */
function core(str) {
  const s = String(str || '').toLowerCase().replace(/&/g, ' and ').replace(/\(m\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const t = s ? s.split(' ') : [];
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

function gqlString(s) {
  return JSON.stringify(String(s));
}

/** One GraphQL call. Returns { ok: true, data } or { ok: false, reason, excerpt }. Never throws. */
async function post(query) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    const blocked = /captcha|challenge|cloudflare/i.test(text);
    return { ok: false, reason: blocked ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 200) };
  }
  const list = json?.data?.companyLists;
  if (!list || !Array.isArray(list.nodes)) {
    return { ok: false, reason: 'layout_changed', excerpt: JSON.stringify(json).slice(0, 200) };
  }
  return { ok: true, data: list };
}

function listQuery(keyword, after) {
  const args = [];
  if (keyword !== null) args.push(`keyword: ${gqlString(keyword)}`);
  args.push('first: 21');
  if (after) args.push(`after: ${gqlString(after)}`);
  return `{ companyLists(${args.join(', ')}) { totalCount pageInfo { hasNextPage endCursor } nodes { company { name registerName slug industry } } } }`;
}

function toRecord(c) {
  return {
    name: c.name || '',
    register_name: c.registerName || '',
    slug: c.slug || '',
    industry: c.industry || '',
    profile_url: `${SITE}/companies/${c.slug}`,
  };
}

function matchesOf(nodes, want) {
  const out = [];
  for (const n of nodes) {
    const c = n?.company;
    if (!c) continue;
    if (core(c.name) === want || core(c.registerName) === want) out.push(toRecord(c));
  }
  return out;
}

function foundAnswer(records, keyword) {
  const first = records[0];
  return {
    status: 'found', reason: '', records,
    source_url: first.profile_url,
    excerpt: `Hiredly lists "${first.name}" (registered as "${first.register_name}"), industry: ${first.industry}`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Windows + Node 24: the runner's process.exit() right after the last fetch can crash while the socket closes
  // (libuv assertion, exit 127), and the answer is then lost. A short settle lets the socket finish closing first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  const kw = String(keyword ?? '').trim();
  const searchUrl = `${SITE}/companies?search=${encodeURIComponent(kw)}`;
  const want = core(kw);
  if (!want) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
  }
  try {
    // Step 1: the site's own search (one request). A match here is already the answer.
    const s = await post(listQuery(kw, null));
    if (!s.ok) return { status: 'couldnt_check', reason: s.reason, records: [], source_url: searchUrl, excerpt: s.excerpt };
    const hits = matchesOf(s.data.nodes, want);
    if (hits.length) return foundAnswer(hits, kw);

    // Step 2: the search did not match. Read the whole list and compare registered names as well.
    const records = [];
    let after = null, checked = 0, total = null, pages = 0;
    for (;;) {
      if (Date.now() - started > LIST_BUDGET_MS || pages >= MAX_PAGES) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl,
          excerpt: `company list read partly: ${checked} of ${total ?? '?'} checked` };
      }
      const p = await post(listQuery(null, after));
      if (!p.ok) return { status: 'couldnt_check', reason: p.reason, records: [], source_url: searchUrl, excerpt: p.excerpt };
      pages += 1;
      total = p.data.totalCount;
      checked += p.data.nodes.length;
      records.push(...matchesOf(p.data.nodes, want));
      const pi = p.data.pageInfo || {};
      if (!pi.hasNextPage || !pi.endCursor || p.data.nodes.length === 0) break;
      after = pi.endCursor;
    }

    if (records.length) return foundAnswer(records, kw);
    if (checked !== total) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: `company list incomplete: ${checked} of ${total} read` };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `Hiredly company list (${checked} companies) has no company named "${kw}" as brand or registered name`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 200) };
  }
}
