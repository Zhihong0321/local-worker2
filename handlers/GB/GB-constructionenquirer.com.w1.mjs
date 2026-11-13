export const meta = { task: 'GB-constructionenquirer.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'description', 'sectors', 'address', 'telephone', 'website', 'profile_url'],
  canary: { found: 'Balfour Beatty', not_found: 'Dezeno' } };

const BASE = 'https://www.constructionenquirer.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'cic', 'cio', 'co', 'company']);
const FETCH_TIMEOUT_MS = 25000;
const DEADLINE_MS = 55000; // every fetch starts only if it can finish before this, so the whole call stays under 60 s
const MAX_PROFILES = 5;

// Tokens of a name, lower-cased, punctuation removed, "&" read as "and".
function tokens(str) {
  return (str || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

// Name without legal form, e.g. "Morgan Maskall Ltd" -> "morganmaskall". Falls back to the full name if nothing is left.
function coreName(str) {
  const all = tokens(str);
  const core = all.filter((t) => !LEGAL_FORMS.has(t));
  return (core.length ? core : all).join('');
}

// Search text: the name as typed, minus the legal form (the site finds nothing when "Ltd"/"plc" is in the query).
function searchText(keyword) {
  const words = (keyword || '').trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !LEGAL_FORMS.has(tokens(w).join('')));
  return (kept.length ? kept : words).join(' ');
}

function cleanText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#8217;|&rsquo;/gi, "'").replace(/&#038;/gi, '&')
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Parse one firm profile page (/directory/<slug>/). */
function parseProfile(html, url) {
  const nameMatch = html.match(/<h1 class="entry-title">([\s\S]*?)<\/h1>/i);
  if (!nameMatch) return null;
  const name = cleanText(nameMatch[1]);
  const descMatch = html.match(/<div class="description">([\s\S]*?)<\/div>/i);
  const description = descMatch ? cleanText(descMatch[1]) : '';
  const siteMatch = html.match(/<a href="([^"]+)" target="_blank">Website<\/a>/i);
  const website = siteMatch ? siteMatch[1] : '';
  // Info column: phone is a bare text item; address is the item with <br> line breaks.
  const infoWrap = html.match(/<div class="info-column-wrap[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i)?.[0] || html;
  const items = [...infoWrap.matchAll(/<div class="item">([\s\S]*?)<\/div>/gi)].map((m) => m[1]);
  const phoneItem = items.find((i) => /^\s*\+?[\d\s()-]{7,}\s*$/.test(cleanText(i)));
  const telephone = phoneItem ? cleanText(phoneItem) : '';
  const addrItem = items.find((i) => /<br/i.test(i));
  const address = addrItem ? cleanText(addrItem) : '';
  const articleClass = html.match(/<article [^>]*class="([^"]*)"/i)?.[1] || '';
  const sectors = [...articleClass.matchAll(/ce_directory_sectors-([a-z0-9-]+)/g)].map((m) => m[1].replace(/-/g, ' '));
  return {
    name,
    description,
    sectors,
    address,
    telephone,
    website,
    profile_url: url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const searchUrl = `${BASE}/directory/search?search-text=${encodeURIComponent(searchText(keyword))}`;
  const want = coreName(keyword);
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  const timeLeft = () => DEADLINE_MS - (Date.now() - started);

  try {
    if (!want) return fail('other', searchUrl, 'empty company name');
    if (timeLeft() < FETCH_TIMEOUT_MS) return fail('timeout', searchUrl, 'no time left for the search request');

    const res = await fetch(searchUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const finalUrl = res.url || searchUrl;
    if (/ce-backend-user|\/directory\/join\/?$/i.test(finalUrl)) {
      return fail('blocked', finalUrl, 'login wall');
    }
    if (/Just a moment\.\.\.|challenge-platform|cf-chl|captcha-delivery/i.test(html)) {
      return fail('blocked', finalUrl, 'bot check page');
    }

    // Case 1: the search found exactly one firm and the site opened its profile straight away.
    if (/<h1 class="entry-title">/i.test(html) && /\/directory\/[^/]+\/?$/i.test(finalUrl) && !/\/directory\/search/i.test(finalUrl)) {
      const profile = parseProfile(html, finalUrl);
      if (!profile) return fail('layout_changed', finalUrl, html.slice(0, 300));
      if (coreName(profile.name) !== want) {
        // The one hit is a different firm: the site answered and this company is not listed.
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `Only hit was "${profile.name}"` };
      }
      return { status: 'found', reason: '', records: [profile], source_url: finalUrl, excerpt: [profile.description, profile.address].filter(Boolean).join(' | ').slice(0, 500) };
    }

    // Case 2: no firm matched.
    if (/Sorry, no companies matched your criteria/i.test(html)) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'Sorry, no companies matched your criteria.' };
    }

    // Case 3: a list of firms.
    if (!/Search results for/i.test(html)) return fail('layout_changed', finalUrl, html.slice(0, 300));

    const listed = [...html.matchAll(/<h3><a href="(https?:\/\/[^"]+\/directory\/[^"\/?#]+\/?)">([^<]*)<\/a><\/h3>/gi)]
      .map((m) => ({ url: m[1], name: cleanText(m[2]) }))
      .filter((r) => !/\/directory\/(search|sectors|join|manage|reset-password)\b/i.test(r.url));
    const matches = listed.filter((r) => coreName(r.name) === want).slice(0, MAX_PROFILES);
    if (!matches.length) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `${listed.length} results, none named like "${keyword}"` };
    }

    // Read each matching firm's profile in parallel (only if the call can still finish inside the deadline).
    if (timeLeft() < FETCH_TIMEOUT_MS) return fail('timeout', searchUrl, 'ran out of time before reading profiles');
    const profiles = await Promise.all(matches.map(async (m) => {
      try {
        const r = await fetch(m.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) return { error: `HTTP ${r.status}`, url: m.url };
        const p = parseProfile(await r.text(), m.url);
        return p ? { profile: p } : { error: 'layout_changed', url: m.url };
      } catch (e) {
        return { error: String(e?.name || e?.message || e), url: m.url };
      }
    }));
    const failed = profiles.find((p) => p.error);
    if (failed) {
      return fail(/timeout|abort/i.test(failed.error) ? 'timeout' : failed.error === 'layout_changed' ? 'layout_changed' : 'http_error', failed.url, failed.error);
    }
    const records = profiles.map((p) => p.profile);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => [r.name, r.address].filter(Boolean).join(' | ')).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, searchUrl, String(err?.message || err));
  }
}
