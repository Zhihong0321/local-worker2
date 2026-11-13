export const meta = { task: 'DE-munich-startup.de', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'listed_name', 'description', 'founding_date', 'street', 'postal_code', 'city', 'website'],
  canary: { found: 'Narrashift', not_found: 'Zwiebelkuchen Vertriebs GmbH' } };

// Source: the site's public sitemap lists every startup page (/startups-and-ecosystem/<slug>).
// The lookup finds slug candidates in that list, then reads each candidate page and compares its
// organisation name with the keyword. The site's /api/ paths are disallowed in robots.txt and are not used.

const BASE = 'https://www.munich-startup.de';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['gmbh', 'ug', 'ag', 'kg', 'ohg', 'gbr', 'se', 'ev', 'mbh', 'kgaa', 'ltd', 'limited', 'inc', 'llc', 'co',
  'haftungsbeschraenkt', 'haftungsbeschrankt']);
const MAX_CANDIDATES = 25;
const DEADLINE_MS = 55000;

/** Lower-case word tokens with German umlauts and accents folded. */
function tokens(s) {
  let t = String(s || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return t.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Name tokens without the legal form (GmbH, UG, AG, KG, e.K. ...) at the end. */
function core(s) {
  const t = tokens(s);
  if (t.length >= 3 && t[t.length - 2] === 'e' && t[t.length - 1] === 'k') t.splice(-2);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

function classify(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function getPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** '' when the answer is usable, otherwise the couldnt_check reason. */
function problem(page) {
  if (page.status === 403 || page.status === 429) return 'blocked';
  if (page.status < 200 || page.status >= 300) {
    if (/captcha|cf-chl|challenge-platform/i.test(page.text)) return 'blocked';
    return 'http_error';
  }
  return '';
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The startup's own Organization record (JSON-LD), skipping the site's own Organization block. */
function findOrg(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    for (const it of Array.isArray(parsed) ? parsed : [parsed]) {
      if (it && it['@type'] === 'Organization' && it.name && it.name !== 'Munich Startup' && !String(it.url || '').includes('munich-startup.de')) {
        return it;
      }
    }
  }
  return null;
}

async function run(keyword) {
  const want = core(keyword);
  if (want.length === 0) return fail('other', BASE, 'the company name has no usable characters');
  const wantKey = want.join('');
  const first = want[0];

  // 1. Sitemap index -> startup sitemaps -> every startup slug
  const indexUrl = `${BASE}/sitemap.xml`;
  const idx = await getPage(indexUrl);
  const idxProblem = problem(idx);
  if (idxProblem) return fail(idxProblem, indexUrl, `HTTP ${idx.status}`);
  const sitemapUrls = [...new Set([...idx.text.matchAll(/<loc>\s*(https:\/\/www\.munich-startup\.de\/sitemap\/startups-\d+\.xml)\s*<\/loc>/g)].map(m => m[1]))];
  if (sitemapUrls.length === 0) return fail('layout_changed', indexUrl, idx.text.slice(0, 300));

  const parts = await Promise.all(sitemapUrls.map(u => getPage(u).then(r => ({ u, r }), e => ({ u, err: e }))));
  const slugSet = new Set();
  for (const p of parts) {
    if (p.err) return fail(classify(p.err), p.u, String(p.err?.message || p.err));
    const pr = problem(p.r);
    if (pr) return fail(pr, p.u, `HTTP ${p.r.status}`);
    for (const m of p.r.text.matchAll(/<loc>https:\/\/www\.munich-startup\.de\/startups-and-ecosystem\/([^<\/\s]+)<\/loc>/g)) slugSet.add(m[1]);
  }
  if (slugSet.size === 0) return fail('layout_changed', sitemapUrls[0], 'no startup entries in the startup sitemaps');

  // 2. Slug candidates: the first word of the name must be the first word of the slug
  const candidates = [...slugSet].filter(s => s.split('-')[0] === first);
  if (candidates.length === 0) {
    return {
      status: 'not_found', reason: '', records: [], source_url: indexUrl,
      excerpt: `No startup page slug starts with "${first}" (startup sitemaps list ${slugSet.size} startups)`,
    };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return fail('other', indexUrl, `${candidates.length} slug candidates start with "${first}", too many to check in 60 s`);
  }

  // 3. Read each candidate page and compare its organisation name with the keyword
  const checks = await Promise.all(candidates.map(async slug => {
    const url = `${BASE}/startups-and-ecosystem/${slug}`;
    try {
      const page = await getPage(url);
      if (page.status === 404) return { state: 'no' };
      const pr = problem(page);
      if (pr) return { state: 'err', reason: pr, url, detail: `HTTP ${page.status}` };
      const org = findOrg(page.text);
      const h1 = cleanText((page.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
      if (!org && !h1) return { state: 'err', reason: 'layout_changed', url, detail: 'no organisation record or title on the page' };
      const orgName = org ? org.name : '';
      const isMatch = (orgName && core(orgName).join('') === wantKey) || (h1 && core(h1).join('') === wantKey);
      if (!isMatch) return { state: 'no' };
      const addr = (org && org.address) || {};
      const rec = {
        name: orgName || h1,
        listed_name: h1 || orgName,
        description: String((org && org.description) || '').slice(0, 1000),
        founding_date: String((org && org.foundingDate) || ''),
        street: String(addr.streetAddress || ''),
        postal_code: String(addr.postalCode || ''),
        city: String(addr.addressLocality || ''),
        website: String((org && org.url) || ''),
      };
      return { state: 'match', rec, url };
    } catch (err) {
      return { state: 'err', reason: classify(err), url, detail: String(err?.message || err) };
    }
  }));

  const matches = checks.filter(c => c.state === 'match');
  if (matches.length) {
    const seen = new Set();
    const records = [];
    for (const m of matches) {
      const k = m.url;
      if (!seen.has(k)) { seen.add(k); records.push(m.rec); }
    }
    const r0 = records[0];
    return {
      status: 'found', reason: '', records, source_url: matches[0].url,
      excerpt: `${r0.listed_name}${r0.founding_date ? ' · founded ' + r0.founding_date : ''}${r0.city ? ' · ' + r0.city : ''}: ${r0.description}`.slice(0, 500),
    };
  }
  const errs = checks.filter(c => c.state === 'err');
  if (errs.length) {
    // A candidate could not be read, so absence is not proven.
    const e0 = errs.find(e => e.reason === 'blocked') || errs[0];
    return fail(e0.reason, e0.url, `${errs.length} of ${candidates.length} candidate pages could not be read (${e0.detail || e0.reason})`);
  }
  return {
    status: 'not_found', reason: '', records: [], source_url: indexUrl,
    excerpt: `None of ${candidates.length} startup page(s) starting with "${first}" has the name "${keyword}"`,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(fail('timeout', BASE, 'the lookup did not finish in 55 s')), DEADLINE_MS);
  });
  try {
    return await Promise.race([run(String(keyword ?? '')), deadline]);
  } catch (err) {
    return fail(classify(err), BASE, String(err?.message || err));
  } finally {
    clearTimeout(timer);
  }
}
