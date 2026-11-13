export const meta = {
  task: 'DE-jobware.de',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'location', 'founded', 'employees', 'website', 'facts'],
  canary: { found: 'Ingenics AG', not_found: 'Zwiebelbauer Traumfabrik GmbH' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};
// Jobware's public sitemap of company profiles (robots.txt allows /jobsearch/sitemap/ and /unternehmen/).
const SITEMAP_URL = 'https://www.jobware.de/jobsearch/sitemap/sitemap-company-profiles.xml';
// Legal-form words, dropped from the end of a name on both sides before comparing.
const LEGAL = new Set(['gmbh', 'mbh', 'gmb', 'h', 'mb', 'b', 'ag', 'kg', 'kgaa', 'co', 'se', 'ug', 'ohg', 'gbr', 'ek', 'e', 'k', 'eg', 'und', 'ltd', 'inc']);

function coreKey(tokens) {
  const t = tokens.slice();
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join('');
}

/** Normalised comparison key for a company name typed by the user (case, umlauts, punctuation, legal form). */
function nameKey(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' ');
  return coreKey(s.split(/[^a-z0-9]+/).filter(Boolean));
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&uuml;/gi, 'ü').replace(/&ouml;/gi, 'ö').replace(/&auml;/gi, 'ä').replace(/&szlig;/gi, 'ß')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function failOf(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** One GET. Never throws: returns { text, url } or { reason, url, excerpt }. */
async function getPage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
    return { url, text: await res.text() };
  } catch (err) {
    return { reason: failOf(err), url, excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Reads one company profile page. Returns null when the expected layout is not there. */
function parseProfile(html, url) {
  const h1 = html.match(/<h1[^>]*advertiser-profile-summary__title[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) return null;
  const name = cleanText(h1[1].replace(/<span[^>]*nrmdy-visually-hidden[^>]*>[\s\S]*?<\/span>/g, ''));
  if (!name) return null;

  const facts = {};
  const factRe = /<div class="advertiser-profile-summary__fact">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = factRe.exec(html))) {
    const dt = m[1].match(/<dt[^>]*>([\s\S]*?)<\/dt>/);
    const dd = m[1].match(/<dd[^>]*>([\s\S]*?)<\/dd>/);
    if (dt && dd) facts[cleanText(dt[1])] = cleanText(dd[1]);
  }

  let website = '';
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  while ((m = ldRe.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j['@type'] === 'Organization' && Array.isArray(j.sameAs) && j.sameAs[0]) { website = j.sameAs[0]; break; }
    } catch { /* ignore a block that is not JSON */ }
  }

  const pick = (re) => {
    const k = Object.keys(facts).find((label) => re.test(label));
    return k ? facts[k] : '';
  };
  return {
    name,
    profile_url: url,
    location: pick(/sitz|standort|hauptsitz|ort/i),
    founded: pick(/gründ/i),
    employees: pick(/mitarbeit/i),
    website,
    facts,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  try {
    const want = nameKey(kw);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITEMAP_URL,
               excerpt: 'the name has no words left after the legal form is removed' };
    }

    // Step 1: the site's list of company profiles (one sitemap file, public, no login).
    const sm = await getPage(SITEMAP_URL);
    if (sm.reason) return { status: 'couldnt_check', reason: sm.reason, records: [], source_url: SITEMAP_URL, excerpt: sm.excerpt };

    const entries = [];
    const locRe = /<loc>([^<]+)<\/loc>/g;
    let m;
    while ((m = locRe.exec(sm.text))) {
      const loc = m[1].trim();
      const slug = loc.match(/\/unternehmen\/([^/]+?)\.(\d+)\.html$/);
      if (slug) entries.push({ loc, key: coreKey(slug[1].split('-')) });
    }
    if (!entries.length) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SITEMAP_URL,
               excerpt: sm.text.slice(0, 300) };
    }

    const hits = entries.filter((e) => e.key === want);
    if (!hits.length) {
      return { status: 'not_found', reason: '', records: [], source_url: SITEMAP_URL,
               excerpt: `No company profile named "${kw}" in the list of ${entries.length} company profiles` };
    }

    // Step 2: the matching profile pages (fetched in parallel, so the total stays well under 60 s).
    const pages = await Promise.all(hits.map((h) => getPage(h.loc)));
    const bad = pages.find((p) => p.reason);
    if (bad) return { status: 'couldnt_check', reason: bad.reason, records: [], source_url: bad.url, excerpt: bad.excerpt };

    const records = [];
    for (const p of pages) {
      const r = parseProfile(p.text, p.url);
      if (r && nameKey(r.name) === want) records.push(r);
    }
    if (!records.length) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: hits[0].loc,
               excerpt: pages[0].text.slice(0, 300) };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].profile_url,
      excerpt: cleanText(records[0].name + ' ' + Object.entries(records[0].facts).map(([k, v]) => `${k}: ${v}`).join('; ')).slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: failOf(err), records: [], source_url: SITEMAP_URL,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
