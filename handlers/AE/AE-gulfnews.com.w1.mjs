export const meta = { task: 'AE-gulfnews.com', want: 'w1', tier: 2, method: 'embedded_json', pdf: false, input: 'company name',
  fields: ['name', 'headquarters', 'industry', 'year_founded', 'tagline', 'profile_url'],
  canary: { found: 'Emirates Group', not_found: 'شركة النور الصحراوية للتجارة ذ.م.م' } };

// Gulf News publishes a Companies Directory at /companies. The page embeds its entity list as JSON
// ("entities":[...]); the on-page search box only filters that list. The handler reads the list and matches by
// normalised name. Host is gulfnews.com (www.gulfnews.com did not connect from the build PC).
const DIRECTORY_URL = 'https://gulfnews.com/companies';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['llc', 'pjsc', 'psc', 'fze', 'fzco', 'fzllc', 'ltd', 'limited', 'llp', 'inc', 'plc', 'co', 'company', 'corp', 'corporation', 'sa', 'sole', 'establishment']);

/** Lower-case, drop accents, punctuation and legal-form words. Keeps non-Latin letters. */
function normalise(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter(t => t && !LEGAL_FORMS.has(t)).join('');
}

/** Match keys: the full name, and the name without a bracketed part such as "(FAB)". */
function keysFor(name) {
  const full = normalise(name);
  const bare = normalise(String(name || '').replace(/\([^)]*\)/g, ' '));
  return new Set([full, bare].filter(Boolean));
}

/** Index of the bracket that closes the one at `start`, skipping brackets inside JSON strings. */
function matchingBracket(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

/** The entity list embedded in the directory page, or null if it is not there. */
function extractEntities(html) {
  const key = '"entities":[';
  let from = 0;
  for (;;) {
    const at = html.indexOf(key, from);
    if (at < 0) return null;
    const start = at + key.length - 1;
    const end = matchingBracket(html, start);
    if (end > 0) {
      try {
        const arr = JSON.parse(html.slice(start, end));
        if (Array.isArray(arr) && arr.some(e => e && typeof e.name === 'string' && typeof e.slug === 'string')) return arr;
      } catch (_) { /* not the entity list; keep looking */ }
    }
    from = at + key.length;
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const kwKeys = keysFor(kw);
    if (kwKeys.size === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: DIRECTORY_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(DIRECTORY_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25000)
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: DIRECTORY_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (html.length < 50000 && /captcha|challenge-platform|access denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: DIRECTORY_URL, excerpt: 'bot check page' };
    }

    const entities = extractEntities(html);
    if (!entities || !html.includes('entity-page-companies')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: DIRECTORY_URL,
               excerpt: 'directory entity list not found on the page' };
    }

    const matches = entities.filter(e => [...keysFor(e.name)].some(k => kwKeys.has(k)));

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: DIRECTORY_URL,
               excerpt: `Companies Directory lists ${entities.length} companies; none is named "${kw}"` };
    }

    const records = matches.map(e => ({
      name: e.name,
      headquarters: e['headquarters-location'] || '',
      industry: e.industry || '',
      year_founded: e['year-founded'] || '',
      tagline: e.tagline || '',
      profile_url: `https://gulfnews.com/companies/${encodeURIComponent(e.slug)}`
    }));
    const first = matches[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: DIRECTORY_URL,
      excerpt: String(first.tagline || first.description || '').slice(0, 300)
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: DIRECTORY_URL,
      excerpt: String((err && err.message) || err).slice(0, 300)
    };
  }
}
