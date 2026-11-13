export const meta = {
  task: 'AU-careerone.com.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'brand_url', 'open_jobs_on_first_page', 'sample_jobs'],
  canary: { found: 'Deloitte', not_found: 'Zyxwvut Holdings Pty Ltd' },
};

const BASE = 'https://www.careerone.com.au';
const INDEX_URL = `${BASE}/google_xml/brand-sitemap-index.xml`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['pty', 'ltd', 'limited', 'llc', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'plc', 'company']);
const MAX_MATCHES = 5;
const DEADLINE_MS = 45000;

/** Lower-case, accents and apostrophes removed, "&" read as "and", punctuation to single spaces. */
function normalize(str) {
  return String(str || '')
    .replace(/&amp;|&/gi, ' and ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function withoutLegal(norm) {
  return norm.split(' ').filter((t) => t && !LEGAL.has(t)).join(' ');
}

/** Site slugs can start with an internal number, e.g. "3075-csl-behring-au-pty-ltd". */
function core(norm) {
  return norm.replace(/^\d+ /, '');
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function locs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

function brandEntries(xml) {
  const out = new Set();
  for (const u of locs(xml)) {
    const i = u.indexOf('/jobs/br_');
    if (i < 0) continue;
    const raw = u.slice(i + '/jobs/br_'.length).replace(/\/+$/, '');
    let slug = raw;
    try { slug = decodeURIComponent(raw); } catch { /* keep raw */ }
    if (slug) out.add(slug);
  }
  return [...out];
}

/** GET a page. Returns { text } or { fail: { reason, excerpt } }. Never throws. */
async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: { reason: timedOut ? 'timeout' : 'other', excerpt: String(e?.message || e).slice(0, 200) } };
  }
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
  const text = await res.text();
  if (/cf-challenge|Just a moment\.\.\.|Attention Required! \| Cloudflare/i.test(text.slice(0, 5000))) {
    return { fail: { reason: 'blocked', excerpt: 'bot check page' } };
  }
  return { text };
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = normalize(keyword);
    if (!kw) return fail('other', INDEX_URL, 'empty company name');

    // Step 1: the site's own employer-brand index (a plain XML list).
    const idx = await fetchText(INDEX_URL);
    if (idx.fail) return fail(idx.fail.reason, INDEX_URL, idx.fail.excerpt);

    let entries = brandEntries(idx.text);
    const children = locs(idx.text).filter((u) => /\.xml(\?|$)/i.test(u)).slice(0, 3);
    for (const child of children) {
      const r = await fetchText(child);
      if (r.fail) return fail(r.fail.reason, child, r.fail.excerpt);
      entries = entries.concat(brandEntries(r.text));
    }
    entries = [...new Set(entries)];
    if (entries.length < 100) {
      return fail('layout_changed', INDEX_URL, `only ${entries.length} brand entries found in the index`);
    }

    // Step 2: match the name. Exact normalised name first; legal form ignored only as a second step.
    let matches = entries.filter((s) => {
      const n = normalize(s);
      return n === kw || core(n) === kw;
    });
    if (!matches.length) {
      const bare = withoutLegal(kw);
      if (bare) matches = entries.filter((s) => withoutLegal(core(normalize(s))) === bare);
    }
    if (!matches.length) {
      return {
        status: 'not_found', reason: '', records: [], source_url: INDEX_URL,
        excerpt: `No employer brand matching "${keyword}" in the CareerOne brand index (${entries.length} brands listed)`,
      };
    }
    matches = matches.slice(0, MAX_MATCHES);

    // Step 3: read each matched employer page (server-rendered; name in <h1>, job cards in the HTML).
    const records = [];
    let firstUrl = '';
    for (const slug of matches) {
      if (Date.now() - started > DEADLINE_MS) return fail('timeout', INDEX_URL, 'time budget used up');
      const url = `${BASE}/jobs/br_${encodeURIComponent(slug)}`;
      if (!firstUrl) firstUrl = url;
      const page = await fetchText(url);
      if (page.fail) return fail(page.fail.reason, url, page.fail.excerpt);

      const h1 = cleanText((page.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
      if (!/\sjobs$/i.test(h1) || h1.toLowerCase() === 'jobs') {
        return fail('layout_changed', url, `heading is "${h1}", not an employer name`);
      }
      const name = h1.replace(/\s+jobs$/i, '').trim();
      if (core(normalize(name)) !== core(normalize(slug))) {
        return fail('layout_changed', url, `page name "${name}" does not match brand "${slug}"`);
      }

      const jobs = [...page.text.matchAll(/job-card-small-job-title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => cleanText(m[1]));
      records.push({
        name,
        slug,
        brand_url: url,
        open_jobs_on_first_page: jobs.length,
        sample_jobs: jobs.slice(0, 5),
      });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: firstUrl,
      excerpt: records.map((r) => `${r.name}: ${r.open_jobs_on_first_page} job cards on ${r.brand_url}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    return fail('other', INDEX_URL, String(err?.message || err));
  }
}
