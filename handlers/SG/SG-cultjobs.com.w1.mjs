export const meta = {
  task: 'SG-cultjobs.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'employer_url', 'cultjobs_id', 'listed_since', 'open_jobs'],
  canary: { found: 'Deskera', not_found: '新加坡科技有限公司' },
};

const SITE = 'https://cultjobs.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words, dropped on both sides before comparing names.
const LEGAL = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'sdn', 'bhd', 'berhad', 'plc']);

function decode(s) {
  return String(s || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&#0*39;|&#8216;|&#8217;/g, "'")
    .replace(/&#0*34;|&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0*160;|&nbsp;/gi, ' ');
}

function tokens(str) {
  return decode(str).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Comparison key: letters and digits only, no legal form. */
function nameKey(str) {
  return tokens(str).filter((t) => !LEGAL.has(t)).join('');
}

/** Search words: the name without its legal form (fall back to the whole name if nothing is left). */
function searchTerms(str) {
  const core = tokens(str).filter((t) => !LEGAL.has(t));
  return (core.length ? core : tokens(str)).join(' ');
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function getPage(url, accept) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
}

/** One page of the employer-only search. Returns { fail } or { url, items, totalPages }. */
async function searchPage(query, page) {
  const url = `${SITE}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&subtype=employer&per_page=100&page=${page}`;
  const res = await getPage(url, 'application/json');
  if (res.status === 403 || res.status === 429) {
    return { fail: failure('blocked', url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { fail: failure('http_error', url, `HTTP ${res.status}`) };
  }
  const body = await res.text();
  let items = null;
  try { items = JSON.parse(body); } catch { items = null; }
  if (!Array.isArray(items)) {
    const challenge = /captcha|cf-chl|challenge-platform|just a moment/i.test(body);
    return { fail: failure(challenge ? 'blocked' : 'layout_changed', url, body.slice(0, 300)) };
  }
  return { url, items, totalPages: Number(res.headers.get('x-wp-totalpages') || 1) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const raw = String(keyword || '').trim();
  const key = nameKey(raw);
  const searchUrl = `${SITE}/wp-json/wp/v2/search?subtype=employer`;
  try {
    if (!key) return failure('other', searchUrl, 'empty company name');

    const query = searchTerms(raw);
    const first = await searchPage(query, 1);
    if (first.fail) return first.fail;

    // Read further result pages only while the 60 s limit allows it; at most 3 pages.
    const items = [...first.items];
    let complete = first.totalPages <= 3;
    let timedOut = false;
    for (let p = 2; p <= Math.min(first.totalPages, 3); p++) {
      if (elapsed() > 15000) { complete = false; timedOut = true; break; }
      const next = await searchPage(query, p);
      if (next.fail) return next.fail;
      items.push(...next.items);
    }

    const employers = items.filter((x) => x && x.subtype === 'employer' && typeof x.title === 'string' && x.url);
    const seen = new Set();
    const matched = employers.filter((x) => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return nameKey(x.title) === key;
    });

    if (matched.length === 0) {
      if (!complete) {
        return failure(timedOut ? 'timeout' : 'other', first.url,
          `search for "${query}" returned ${first.totalPages} pages; only part was read, no exact match yet`);
      }
      const near = employers.slice(0, 5).map((x) => decode(x.title)).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: first.url,
        excerpt: `No Cultjobs employer named "${raw}" (search "${query}": ${employers.length} employer hit(s)${near ? ': ' + near : ''})`,
      };
    }

    // Read each matched employer page for the listing date and open-job count (two at most, within time).
    const records = [];
    for (const m of matched.slice(0, 3)) {
      const rec = {
        name: decode(m.title),
        employer_url: m.url,
        cultjobs_id: String(m.id),
        listed_since: '',
        open_jobs: '',
      };
      if (elapsed() < 30000 && String(m.url).startsWith(`${SITE}/employer/`)) {
        try {
          const page = await getPage(m.url, 'text/html,application/xhtml+xml');
          if (page.ok) {
            const html = await page.text();
            const d = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2}[^"]*)"/);
            if (d) rec.listed_since = d[1];
            const o = html.match(/Open Job<\/span>\s*-\s*<span>\s*(\d+)\s*<\/span>/i);
            if (o) rec.open_jobs = o[1];
          }
        } catch {
          // keep the search fields only
        }
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].employer_url,
      excerpt: `${records.length} Cultjobs employer listing(s) match "${raw}": ${records.map((r) => r.name).join('; ')}`.slice(0, 300),
    };
  } catch (err) {
    return failure(isTimeout(err) ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
