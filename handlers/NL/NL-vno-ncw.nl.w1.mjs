export const meta = { task: 'NL-vno-ncw.nl', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'post_id', 'membership', 'website', 'description'],
  canary: { found: 'NOVAKA', not_found: 'Krakeelvlinder Trading B.V.' } };

// The member directory on https://www.vno-ncw.nl/leden is filled by the site's own search proxy (Elasticsearch):
// one anonymous POST returns the members (post_type "member"). The list holds member organisations, not registry records.
const ES_URL = 'https://www.vno-ncw.nl/es/vnoncw-mkb-prod-post,vno-ncw-prod-post/_search';
const SOURCE_URL = 'https://www.vno-ncw.nl/leden';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_SUFFIX = /\s+(b v|n v|v o f|c v|bv|nv|vof|cv)$/;

function decode(s) {
  return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&#x27;|&rsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

/** Compare names: case, accents, punctuation and a trailing Dutch legal form (B.V., N.V., V.O.F., C.V.) do not count. */
function normalize(s) {
  const t = decode(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return t.replace(LEGAL_SUFFIX, '').trim();
}

/** The site stores membership as a PHP-serialised list, e.g. a:1:{i:0;s:20:"branch_organisations";} */
function membershipLabels(meta) {
  const raw = meta?.membership?.[0]?.value || '';
  return [...raw.matchAll(/s:\d+:"([^"]+)"/g)].map((m) => m[1]);
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: SOURCE_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword ?? '').trim();
  const want = normalize(name);
  if (!want) return fail('other', 'empty company name');
  try {
    const body = {
      size: 1000,
      _source: ['post_id', 'post_title', 'post_excerpt', 'meta.website_url', 'meta.membership'],
      query: { bool: { filter: [{ term: { post_type: 'member' } }] } },
    };
    const res = await fetch(ES_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    let data;
    try { data = await res.json(); } catch { return fail('layout_changed', 'response is not JSON'); }
    const hits = data?.hits?.hits;
    const total = data?.hits?.total?.value;
    if (!Array.isArray(hits) || typeof total !== 'number') {
      return fail('layout_changed', JSON.stringify(data));
    }
    if (total > hits.length) {
      return fail('other', `${total} members, more than one request reads`);
    }

    const matches = hits.filter((h) => normalize(h?._source?.post_title) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SOURCE_URL,
        excerpt: `Checked ${hits.length} member entries on the VNO-NCW member list; none is named "${name}"`,
      };
    }

    const records = matches.map((h) => {
      const s = h._source || {};
      return {
        name: decode(s.post_title),
        post_id: s.post_id ?? null,
        membership: membershipLabels(s.meta),
        website: s.meta?.website_url?.[0]?.value || '',
        description: decode(s.post_excerpt),
      };
    });
    return {
      status: 'found', reason: '', records, source_url: SOURCE_URL,
      excerpt: `VNO-NCW member list: ${records.map((r) => r.name).join('; ')}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
