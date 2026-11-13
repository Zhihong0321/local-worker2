export const meta = { task: 'AE-twofour54.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'slug', 'url', 'language'], canary: { found: 'Weber Shandwick', not_found: 'شركة نجوم الصحراء للإنتاج الفني ذ.م.م' } };

// twofour54 publishes its partner directory through a JSON API (the site's own front end calls it with a `language` header).
// The directory lists partner names and logos only: no registration number, status or address is published.
const API = 'https://newhosting.twofour54.com/api/v1/partners';
const SITE = 'https://www.twofour54.com';
const LANGS = ['en', 'ar'];
const PER_PAGE = 25;
const MAX_PAGES = 10;
const DEADLINE_MS = 30000; // do not start a new request after 30 s, so the whole call ends well under 60 s
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, removed only at the end of a name (and "the" only at the start).
const LEGAL = new Set(['llc', 'fz', 'fze', 'fzc', 'fzco', 'fzllc', 'ltd', 'limited', 'llp', 'inc', 'corp', 'corporation',
  'gmbh', 'pjsc', 'lp', 'dmcc', 'opc', 'sole', 'proprietorship', 'establishment', 'branch', 'co',
  'ذمم', 'شمع', 'ذ', 'م', 'ش', 'ع']);

// Marketing text the directory adds after the company name, e.g. "Nomad Creative Partner Supporting Media at twofour54".
const TITLE_CUTS = [' | ', ' - ', ' – ', ' (', ' in twofour54', ' at twofour54', ' partner', ' creative', ' production', ' community', ' network'];

function decode(s) {
  let out = String(s || '');
  for (let i = 0; i < 3; i++) {
    out = out.replace(/&amp;/gi, '&').replace(/&#x27;|&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ');
  }
  return out.normalize('NFKC');
}

function arabicFold(s) {
  return s.replace(/[ً-ٰٟـ]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

// Split a name into lower-case words; dotted initials such as L.L.C. are joined first.
function words(s) {
  const t = decode(s).replace(/\b(?:[a-zA-Z]\.){2,}/g, (m) => m.replace(/\./g, '')).replace(/&/g, ' and ');
  return arabicFold(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// The comparison key: words without trailing legal form and without a leading "the".
function keyOf(text) {
  const w = words(text);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  if (w.length > 1 && w[0] === 'the') w.shift();
  return w.join(' ');
}

// Keys a directory title can match: the full title, and the title before any marketing text.
function titleKeys(title) {
  const full = decode(title);
  const lower = full.toLowerCase();
  let cut = full.length;
  for (const m of TITLE_CUTS) {
    const i = lower.indexOf(m);
    if (i > 0 && i < cut) cut = i;
  }
  return [keyOf(full), keyOf(full.slice(0, cut))].filter(Boolean);
}

// The text sent to the directory search: the name as typed, without a trailing legal form.
function searchTerm(keyword) {
  const parts = decode(keyword).replace(/\b(?:[a-zA-Z]\.){2,}/g, (m) => m.replace(/\./g, '')).trim().split(/\s+/);
  while (parts.length && LEGAL.has(arabicFold(parts[parts.length - 1]).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))) parts.pop();
  return parts.join(' ').replace(/^[\s,.\-]+|[\s,.\-]+$/g, '');
}

function searchUrl(term, page) {
  return `${API}?title=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`;
}

/** One search request. Returns { ok:true, list, total } or { ok:false, reason, excerpt }. */
async function search(term, lang, page) {
  const url = searchUrl(term, page);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'language': lang },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, url, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, url, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, url, reason: 'http_error', excerpt: `HTTP ${res.status}` };

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, url, reason: 'layout_changed', excerpt: 'response is not JSON' };
  }
  if (body && body.success === false) return { ok: false, url, reason: 'other', excerpt: String(body.message || 'success=false').slice(0, 300) };
  const cp = body?.data?.communityPartners;
  if (!cp || !Array.isArray(cp.list) || typeof cp.paging?.total !== 'number') {
    return { ok: false, url, reason: 'layout_changed', excerpt: JSON.stringify(body).slice(0, 300) };
  }
  return { ok: true, url, list: cp.list, total: cp.paging.total };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startedAt = Date.now();
  const firstUrl = searchUrl(searchTerm(keyword) || String(keyword || ''), 1);
  try {
    const term = searchTerm(keyword);
    const key = keyOf(keyword);
    if (!term || !key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
        excerpt: 'no company name left to search after removing the legal form' };
    }

    const records = [];
    const seenSlugs = new Set();
    let totalSeen = 0;

    for (const lang of LANGS) {
      let page = 1;
      let total = Infinity;
      while ((page - 1) * PER_PAGE < total) {
        if (page > MAX_PAGES) {
          return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl(term, 1),
            excerpt: `more than ${MAX_PAGES * PER_PAGE} directory results for "${term}"; not checked in full` };
        }
        if (Date.now() - startedAt > DEADLINE_MS) {
          return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl(term, page),
            excerpt: 'the directory search did not finish in time' };
        }
        const r = await search(term, lang, page);
        if (!r.ok) return { status: 'couldnt_check', reason: r.reason, records: [], source_url: r.url, excerpt: r.excerpt };

        total = r.total;
        totalSeen += r.list.length;
        for (const item of r.list) {
          const slug = String(item.slug || '');
          if (!slug || seenSlugs.has(slug)) continue;
          if (titleKeys(item.title || '').includes(key)) {
            seenSlugs.add(slug);
            records.push({
              name: decode(item.title).trim(),
              slug,
              url: `${SITE}/${lang}/twofour54-community/partners/${slug}/`,
              language: lang,
            });
          }
        }
        page++;
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `twofour54 partner directory, search "${term}": ${records.map((r) => r.name).join('; ')}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `twofour54 partner directory, search "${term}" in ${LANGS.join(' and ')}: ${totalSeen} result(s), none matches "${keyword}"`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
