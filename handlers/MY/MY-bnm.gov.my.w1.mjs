export const meta = {
  task: 'MY-bnm.gov.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'registration_number', 'added_date', 'websites'],
  canary: { found: 'MonSpace (M) Sdn Bhd', not_found: 'Dezeno' },
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://api.bnm.gov.my/public/consumer-alert';
const ACCEPT = 'application/vnd.BNM.API.v1+json';

const clip = (s, n = 500) => String(s == null ? '' : s).slice(0, n);

/** Look one company up on BNM's Financial Consumer Alert list (the site's own public JSON API). */
export default async function lookup(keyword) {
  const q = String(keyword == null ? '' : keyword).trim();
  const source = q ? `${BASE}/${encodeURIComponent(q)}` : BASE;
  if (!q) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: source,
      excerpt: 'empty keyword',
    };
  }

  let res;
  let text = '';
  try {
    res = await fetch(source, {
      method: 'GET',
      headers: { Accept: ACCEPT, 'User-Agent': UA, 'Accept-Language': 'en-MY,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (e) {
    const name = e && e.name;
    return {
      status: 'couldnt_check',
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'http_error',
      records: [],
      source_url: source,
      excerpt: clip(`fetch failed: ${name || e}`),
    };
  }

  // A bot check / WAF challenge or rate limit is never worked around.
  if (res.status === 403 || res.status === 429 || res.status === 202 || res.status === 503) {
    return {
      status: 'couldnt_check',
      reason: 'blocked',
      records: [],
      source_url: source,
      excerpt: clip(`HTTP ${res.status} ${res.headers.get('x-amzn-waf-action') || ''} ${text}`),
    };
  }
  if (!res.ok) {
    return {
      status: 'couldnt_check',
      reason: 'http_error',
      records: [],
      source_url: source,
      excerpt: clip(`HTTP ${res.status} ${text}`),
    };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: source,
      excerpt: clip(`not JSON: ${text}`),
    };
  }

  // The answer only counts if the API still returns its documented shape.
  const looksRight =
    body &&
    typeof body === 'object' &&
    Array.isArray(body.data) &&
    body.meta &&
    typeof body.meta === 'object' &&
    typeof body.meta.total_result === 'number';
  if (!looksRight) {
    return {
      status: 'couldnt_check',
      reason: 'layout_changed',
      records: [],
      source_url: source,
      excerpt: clip(`unexpected JSON shape: ${text}`),
    };
  }

  const lastUpdated = String(body.meta.last_updated || '');
  const rows = body.data.map((r) => ({
    name: String(r.name || ''),
    registration_number: String(r.regisration_number || r.registration_number || ''),
    added_date: String(r.added_date || ''),
    websites: Array.isArray(r.websites) ? r.websites.join(' ; ') : String(r.websites || ''),
  }));

  if (rows.length > 0) {
    const excerpt = clip(
      `BNM Financial Consumer Alert (list last_updated ${lastUpdated}), ${body.meta.total_result} match(es): ` +
        rows
          .slice(0, 6)
          .map((r) => `${r.name}${r.registration_number ? ` [${r.registration_number}]` : ''} added ${r.added_date}`)
          .join(' | '),
    );
    return { status: 'found', reason: '', records: rows, source_url: source, excerpt };
  }

  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: source,
    excerpt: clip(
      `BNM Financial Consumer Alert (list last_updated ${lastUpdated}): no entry for "${q}" (total_result 0). ` +
        'Not on the alert list; this does not prove the entity is licensed.',
    ),
  };
}
