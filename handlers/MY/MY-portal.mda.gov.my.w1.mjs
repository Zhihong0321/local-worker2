export const meta = {
  task: 'MY-portal.mda.gov.my',
  want: 'w1',
  tier: 1,
  method: 'html_url',
  input: 'company name',
  fields: ['name', 'license_no', 'license_type', 'validity', 'status'],
  canary: { found: 'B. Braun Medical Industries Sdn Bhd', not_found: 'YYC Advisors' },
};

// The portal page https://portal.mda.gov.my/ links out to the public register, which is served
// from mdar.mda.gov.my (mmdr.mda.gov.my/public/ redirects there). Its licensed-establishment
// search is a plain GET form, so the company name can simply go into the URL and the result
// table comes back as HTML.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function searchUrl(name) {
  return (
    'https://mdar.mda.gov.my/frontend/web/index.php?r=carian-el%2Findex' +
    '&CompletedApplicationElSearch%5BglobalSearch%5D=' +
    encodeURIComponent(name)
  );
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function cells(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
    decode(m[1].replace(/<[^>]+>/g, ' '))
  );
}

/** the validity column is "DD-MM-YYYY - DD-MM-YYYY" */
function statusFromValidity(validity) {
  const dates = String(validity).match(/\d{2}-\d{2}-\d{4}/g) || [];
  if (!dates.length) return '';
  const last = dates[dates.length - 1];
  const [d, m, y] = last.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  return end >= Date.now() ? 'Active' : 'Expired';
}

export default async function lookup(keyword) {
  const empty = { status: 'not_found', reason: '', records: [], source_url: '', excerpt: '' };
  const raw = String(keyword || '').trim();
  if (!raw) return { ...empty, status: 'couldnt_check', reason: 'other', excerpt: 'empty query' };

  // the register stores legal names like "B. BRAUN ... SDN. BHD.", so a query that repeats the
  // suffix without its full stop misses the LIKE search: try the name with and without it, then
  // progressively shorter prefixes. The register itself does the filtering, so no rows is a real miss.
  const words = raw.split(/\s+/).filter(Boolean);
  const withoutSuffix = words.filter((w) => !/^(sdn|bhd|berhad|sendirian|ltd|limited|plt)\.?$/i.test(w));
  const attempts = [
    withoutSuffix.join(' '),
    raw,
    withoutSuffix.slice(0, 2).join(' '),
    withoutSuffix[0],
  ].filter((v, i, a) => v && v.trim() && a.indexOf(v) === i);

  let lastUrl = '';
  for (const q of attempts) {
    const r = await search(q);
    if (r.status !== 'not_found') return r; // found, or couldn't check
    lastUrl = r.source_url || lastUrl;
  }
  return {
    ...empty,
    source_url: lastUrl,
    excerpt: `No licensed medical device establishment matches "${raw}" (register says: No results found).`,
  };
}

async function search(query) {
  const url = searchUrl(query);
  let html;
  try {
    await new Promise((r) => setTimeout(r, 1000)); // one request a second
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow', // the app 307s to the canonical ?r=... URL
      signal: AbortSignal.timeout(30000),
    });
    html = await res.text();
    if (res.status !== 200 || !html) {
      return {
        status: 'couldnt_check',
        reason: res.status === 403 || res.status === 429 ? 'blocked' : 'http_error',
        records: [], source_url: url, excerpt: 'http ' + res.status,
      };
    }
  } catch (e) {
    return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: String(e.message).slice(0, 200) };
  }

  if (!/id="example1"/.test(html)) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'result table id="example1" not found' };
  }
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbody) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'no tbody in result table' };
  }

  const body = tbody[1];
  if (/No results found|class="empty"/i.test(body) && !/<tr[^>]*data-key/i.test(body)) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: `No licensed medical device establishment matches "${query}" (register says: No results found).`,
    };
  }

  const records = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => cells(m[1]))
    .filter((c) => c.length >= 5 && c[1])
    .map((c) => ({
      name: c[1],
      license_no: c[2],
      license_type: c[4],
      validity: c[3],
      status: statusFromValidity(c[3]),
    }));

  if (!records.length) {
    return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `No licensed medical device establishment matches "${query}".` };
  }

  const excerpt = records
    .map((r) => [r.name, r.license_no, r.license_type, r.validity, r.status].filter(Boolean).join(' | '))
    .join(' || ')
    .slice(0, 500);

  return { status: 'found', reason: '', records: records.slice(0, 20), source_url: url, excerpt };
}
