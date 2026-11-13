export const meta = { task: 'DE-vdma.org', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'address', 'plz', 'city', 'country', 'website', 'vdma_member_id'],
  canary: { found: 'Festo SE & Co. KG', not_found: 'Zxqwvb Ölmühle Stahlbau GmbH' } };

// The VDMA member directory (vdma.org redirects to vdma.eu) loads its list with a JSON resource request:
// GET ?p_p_resource_id=getPage&..._query=<text>&..._page=<n>. The reply is JSON whose publicUserList field is a
// second JSON string with { totalPages, totalRecords, content: [ { companyName, address, plz, city, country, webAddr, id } ] }.
// The search is case-insensitive substring match on the company name, and it is punctuation-sensitive:
// "Festo SE & Co. KG" finds the company, "Festo SE & Co KG" finds nothing. So the handler tries several query
// variants and matches the results itself, on normalised names (case, accents, punctuation, legal form removed).

const BASE = 'https://www.vdma.eu/de/mitglieder?p_p_id=org_vdma_publicusers_portlet_PublicUsersPortlet_INSTANCE_H0VO3QljCiRM&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_resource_id=getPage&p_p_cacheability=cacheLevelPage';
const QUERY_PARAM = '_org_vdma_publicusers_portlet_PublicUsersPortlet_INSTANCE_H0VO3QljCiRM_query';
const PAGE_PARAM = '_org_vdma_publicusers_portlet_PublicUsersPortlet_INSTANCE_H0VO3QljCiRM_page';
const MAX_PAGES = 5;          // 10 companies per page; more than this and the handler stops and says so
const SOFT_DEADLINE_MS = 33000; // a fetch started before this can still end within 60 s (25 s timeout)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LEGAL = new Set(['gmbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'gbr', 'ug', 'mbh', 'co', 'ek', 'partg', 'gesellschaft',
  'mit', 'beschrankter', 'haftung', 'aktiengesellschaft', 'ltd', 'llc', 'inc', 'limited', 'plc', 'bv', 'nv', 'sa',
  'sarl', 'srl', 'spa', 'sl', 'ab', 'oy', 'sro', 'kft']);

function fold(s) {
  return (s || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase();
}

/** Name words without legal form, punctuation, case or accents. */
function coreTokens(name) {
  return fold(name).split(/[\s&+,;()\/-]+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t && !LEGAL.has(t));
}

function coreKey(name) {
  return coreTokens(name).join('');
}

function isGerman(country) {
  const c = fold(country).trim();
  return c === 'deutschland' || c === 'germany';
}

/** Query variants: the name as typed, the name without legal form and punctuation, and its longest word. */
function queryVariants(keyword) {
  const typed = keyword.replace(/\s+/g, ' ').trim();
  const words = typed.split(/[\s&]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const core = words.filter((w) => !LEGAL.has(fold(w)));
  const variants = [typed];
  if (core.length) variants.push(core.join(' '));
  const longest = core.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest.length >= 3) variants.push(longest);
  const seen = new Set();
  return variants.filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
}

function searchUrl(query, pageIndex) {
  let url = `${BASE}&${QUERY_PARAM}=${encodeURIComponent(query)}`;
  if (pageIndex > 0) url += `&${PAGE_PARAM}=${pageIndex + 1}`;
  return url;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Read every page of one query (up to MAX_PAGES). Returns { rows, truncated } or { error } with a couldnt_check answer. */
async function searchAll(query, startedAt) {
  const rows = [];
  let pageIndex = 0;
  for (;;) {
    const url = searchUrl(query, pageIndex);
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) return { error: couldnt('timeout', url, 'the member directory was still being read at 33 s') };
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.vdma.eu/de/mitglieder',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
      return { error: couldnt(reason, url, String(err && err.message || err)) };
    }
    if (res.status === 403 || res.status === 429) return { error: couldnt('blocked', url, `HTTP ${res.status}`) };
    if (!res.ok) return { error: couldnt('http_error', url, `HTTP ${res.status}`) };

    const text = await res.text();
    if (/captcha|cf-chl|Attention Required|access denied/i.test(text.slice(0, 2000))) {
      return { error: couldnt('blocked', url, text.slice(0, 200)) };
    }
    let list;
    try {
      const outer = JSON.parse(text);
      list = JSON.parse(outer.publicUserList);
    } catch (_) {
      return { error: couldnt('layout_changed', url, text.slice(0, 200)) };
    }
    if (!list || !Array.isArray(list.content) || typeof list.totalPages !== 'number') {
      return { error: couldnt('layout_changed', url, text.slice(0, 200)) };
    }
    rows.push(...list.content);
    pageIndex += 1;
    if (pageIndex >= list.totalPages) return { rows, truncated: false };
    if (pageIndex >= MAX_PAGES) return { rows, truncated: true };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On this Windows Node build, process.exit() right after a fetch aborts with a libuv assertion (exit 127).
  // A short pause lets the connection close first; the answer itself is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  const startedAt = Date.now();
  try {
    const name = String(keyword || '').replace(/\s+/g, ' ').trim();
    if (!name) return couldnt('other', BASE, 'empty company name');
    const key = coreKey(name);
    if (!key) return couldnt('other', BASE, 'no name words left after removing the legal form');

    const variants = queryVariants(name);
    let truncatedQuery = null;
    for (const query of variants) {
      const got = await searchAll(query, startedAt);
      if (got.error) return got.error;
      const matches = got.rows.filter((r) => coreKey(r.companyName || '') === key && isGerman(r.country));
      if (matches.length) {
        const seen = new Set();
        const records = matches
          .filter((r) => !seen.has(r.id) && seen.add(r.id))
          .map((r) => ({
            name: String(r.companyName || '').trim(),
            address: String(r.address || '').trim(),
            plz: String(r.plz || '').trim(),
            city: String(r.city || '').trim(),
            country: String(r.country || '').trim(),
            website: String(r.webAddr || '').trim(),
            vdma_member_id: String(r.id),
          }));
        return {
          status: 'found',
          reason: '',
          records,
          source_url: searchUrl(query, 0),
          excerpt: `VDMA member directory: ${records.length} German member(s) match "${name}" (searched "${query}")`,
        };
      }
      if (got.truncated) truncatedQuery = query;
    }

    if (truncatedQuery !== null) {
      return couldnt('other', searchUrl(truncatedQuery, 0),
        `"${truncatedQuery}" has more than ${MAX_PAGES * 10} results; the handler could not read them all`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl(variants[0], 0),
      excerpt: `VDMA member directory: no German member matches "${name}" (searched ${variants.map((v) => `"${v}"`).join(', ')})`,
    };
  } catch (err) {
    return couldnt('other', BASE, String(err && err.message || err));
  }
}
