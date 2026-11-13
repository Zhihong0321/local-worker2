export const meta = { task: 'IN-vccircle.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'profile_url', 'tag_id', 'news_pages', 'latest_news'],
  canary: { found: 'Tata Steel Ltd', not_found: 'Zzqx Nonexistent Firm Pvt Ltd' } };

// VCCircle has no search. Each company has a profile page at /company/<slug>, and a name that is not on the site
// answers with HTTP 404. The slug is built from the name, so the handler tries a few slug forms and checks the
// name on each page it finds.

const BASE = 'https://www.vccircle.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'opc', 'corp', 'corporation', 'co', 'company']);

/** Words of a name, lower case, without punctuation or "&". */
function words(str) {
  return String(str || '').replace(/&/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Normalised key for comparing names: legal form removed, so "ACME PVT. LTD." and "Acme Private Limited" match. */
function coreKey(str) {
  return words(str).filter(w => !LEGAL.has(w)).join('');
}

/** Slug forms the site uses: "ltd", "pvt-ltd" (never "limited"), with an optional "-2" for duplicate profiles. */
function slugCandidates(name) {
  const raw = words(name);
  const spelled = raw.map(w => (w === 'limited' ? 'ltd' : w === 'private' ? 'pvt' : w === 'corporation' ? 'corp' : w));
  const core = raw.filter(w => !LEGAL.has(w));
  const bases = new Set();
  if (spelled.length) bases.add(spelled.join('-'));
  if (core.length) {
    bases.add([...core, 'ltd'].join('-'));
    bases.add([...core, 'pvt', 'ltd'].join('-'));
    bases.add(core.join('-'));
  }
  const out = new Set();
  for (const b of bases) { out.add(b); out.add(`${b}-2`); }
  return [...out];
}

/** Fetch one profile page. Never throws. */
async function probe(slug) {
  const url = `${BASE}/company/${slug}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 404) return { kind: 'miss', url, slug };
    if (res.status === 403 || res.status === 429) return { kind: 'error', reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { kind: 'error', reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    let data = null;
    if (m) {
      try { data = JSON.parse(m[1]).props?.pageProps?.data ?? null; } catch { data = null; }
    }
    if (!data || !data.tag_details) {
      if (/captcha|attention required|cf-chl/i.test(html)) return { kind: 'error', reason: 'blocked', url, excerpt: 'bot check page' };
      return { kind: 'error', reason: 'layout_changed', url, excerpt: html.slice(0, 200) };
    }
    return { kind: 'page', url, slug, data };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return { kind: 'error', reason, url, excerpt: String(err && err.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }
    // Profile names are English. A name with non-Latin letters cannot be matched, so it is not a "not found".
    const letters = name.match(/\p{L}/gu) || [];
    if (letters.some(c => !/\p{Script=Latin}/u.test(c))) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
        excerpt: 'name is not written in Latin letters; VCCircle profile names are in English, so it cannot be matched' };
    }
    const key = coreKey(name);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
        excerpt: 'no company words left after removing the legal form' };
    }

    const slugs = slugCandidates(name);
    const results = await Promise.all(slugs.map(probe));

    const hits = [];
    const seenIds = new Set();
    for (const r of results) {
      if (r.kind !== 'page') continue;
      const tag = r.data.tag_details;
      if (coreKey(tag.name) !== key || seenIds.has(tag.id)) continue;
      seenIds.add(tag.id);
      hits.push({
        name: String(tag.name).trim(),
        profile_url: r.url,
        tag_id: String(tag.id),
        news_pages: r.data.total_pages ?? null,
        latest_news: (r.data.all_articles || []).slice(0, 3).map(a => ({ title: a.title, published: a.publish })),
      });
    }

    if (hits.length) {
      return {
        status: 'found',
        reason: '',
        records: hits,
        source_url: hits[0].profile_url,
        excerpt: `VCCircle company profile: ${hits.map(h => h.name).join('; ')}`,
      };
    }

    const errs = results.filter(r => r.kind === 'error');
    if (errs.length) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      const worst = errs.slice().sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
      return {
        status: 'couldnt_check',
        reason: worst.reason,
        records: [],
        source_url: worst.url,
        excerpt: `${errs.length} of ${results.length} profile addresses could not be read: ${worst.excerpt}`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}/company/${slugs[0]}`,
      excerpt: `${slugs.length} profile addresses tried for "${name}": HTTP 404 or a different company`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err && err.message || err).slice(0, 200),
    };
  }
}
