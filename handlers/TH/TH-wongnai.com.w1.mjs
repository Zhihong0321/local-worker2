export const meta = {
  task: 'TH-wongnai.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'english_name', 'thai_name', 'branch', 'wongnai_id', 'url', 'closed', 'rating', 'categories', 'hours_status'],
  canary: { found: 'Siam Commercial Bank', not_found: 'บริษัท ซาลาเปาควอนตัมไม่มีจริง จำกัด' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE = 'https://www.wongnai.com';
const PAGE_SIZE = 50;

// Legal-form words (Thai and English) that are removed before comparing names.
const LEGAL = [
  /บริษัท/g, /บจก\.?/g, /บมจ\.?/g, /หจก\.?/g, /ห้างหุ้นส่วนจำกัด/g, /ห้างหุ้นส่วนสามัญ/g, /จำกัด/g, /\(?มหาชน\)?/g,
  /public\s+company\s+limited/gi, /company\s+limited/gi, /\bco\.?\s*,?\s*ltd\.?/gi, /\bpte\.?\s*ltd\.?/gi,
  /\bsdn\.?\s*bhd\.?/gi, /\bpcl\b\.?/gi, /\bplc\b\.?/gi, /\bltd\b\.?/gi, /\binc\b\.?/gi, /\bllc\b\.?/gi,
  /\bcorporation\b\.?/gi, /\bcorp\b\.?/gi, /\bco\b\.?/gi, /\bcompany\b/gi,
];

function stripLegal(str) {
  let s = String(str || '').normalize('NFKC');
  for (const re of LEGAL) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function norm(str) {
  return stripLegal(str).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function cleanObj(v) {
  return v === undefined ? null : v;
}

/** Pull the search-result object that the page embeds as JSON (balanced-brace scan, string-aware). */
function extractSearchResult(html) {
  const key = '"searchResult":{';
  const i = html.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length - 1;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end + 1));
  } catch {
    return null;
  }
}

function recordOf(b) {
  const nameOnly = b.nameOnly || {};
  const temp = b.workingHoursStatus || {};
  return {
    name: nameOnly.primary || b.displayName || b.name || '',
    english_name: nameOnly.english || null,
    thai_name: nameOnly.thai || null,
    branch: (b.branch && b.branch.primary) || null,
    wongnai_id: b.publicId || String(b.id || ''),
    url: b.rUrl ? `${SITE}/${b.rUrl}` : (b.url ? `${SITE}/${b.url}` : null),
    closed: typeof b.closed === 'boolean' ? b.closed : null,
    rating: typeof b.rating === 'number' ? b.rating : null,
    categories: Array.isArray(b.categories) ? b.categories.map((c) => c.name).filter(Boolean) : [],
    hours_status: {
      open: cleanObj(temp.open),
      message: cleanObj(temp.message),
      temporary_close_start: cleanObj(temp.temporaryCloseStartDate),
      temporary_close_end: cleanObj(temp.temporaryCloseEndDate),
    },
  };
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await lookupOnce(keyword);
  // On this Windows Node build the process can exit while the fetch socket is still closing, which crashes
  // (exit 127) after the answer is printed. A short pause lets the socket close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}

async function lookupOnce(keyword) {
  const sourceUrl = '';
  try {
    const input = String(keyword || '').trim();
    if (!input) return couldnt('other', sourceUrl, 'empty company name');

    // Search with the name without its legal form (the site indexes trading names).
    const query = stripLegal(input) || input;
    const searchUrl = `${SITE}/businesses?q=${encodeURIComponent(query)}&page.number=1&page.size=${PAGE_SIZE}&rerank=false`;

    // Same 25 s limit as AbortSignal.timeout(25000), but the timer is cleared when the request ends:
    // on this Windows Node build a pending AbortSignal.timeout timer makes process exit crash (exit 127).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    let res, html;
    try {
      res = await fetch(searchUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'th,en;q=0.8' },
        signal: ac.signal,
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', searchUrl, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', searchUrl, `HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      const name = String(err?.name || '');
      if (name === 'TimeoutError' || name === 'AbortError') return couldnt('timeout', searchUrl, 'no answer within 25 s');
      return couldnt('other', searchUrl, err?.message || err);
    } finally {
      clearTimeout(timer);
    }
    const sr = extractSearchResult(html);
    if (!sr || !sr.value || !Array.isArray(sr.value.data)) {
      // A bot check page (Cloudflare challenge) has no results block at all.
      if (/<title>\s*Just a moment/i.test(html) || /cf-chl-|challenge-form/i.test(html)) {
        return couldnt('blocked', searchUrl, 'bot check page instead of results');
      }
      return couldnt('layout_changed', searchUrl, html.slice(0, 200));
    }
    if (sr.error) return couldnt('other', searchUrl, 'site reported an error: ' + JSON.stringify(sr.error).slice(0, 200));

    const value = sr.value;
    if (typeof value.te !== 'number') return couldnt('layout_changed', searchUrl, 'no total count in results');

    const businesses = value.data.filter((d) => d && d.type === 1 && d.business).map((d) => d.business);
    const kwNorm = norm(input) || norm(query);
    const matches = businesses.filter((b) => {
      const names = [b.nameOnly?.english, b.nameOnly?.thai, b.nameOnly?.primary, b.displayName, b.name];
      return names.some((n) => n && kwNorm && norm(n) === kwNorm);
    });

    if (matches.length > 0) {
      const records = matches.map(recordOf);
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: searchUrl,
        excerpt: `${records.length} listing(s) named "${first.english_name || first.name}"${first.branch ? ` (branch ${first.branch})` : ''}: ${first.url}`,
      };
    }

    // No exact name match. If the site holds more results than we read, the match could be further down.
    if (value.te > businesses.length) {
      return couldnt('other', searchUrl, `no exact match in the first ${businesses.length} of ${value.te} results`);
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `Wongnai search for "${query}": ${value.te} result(s), none named "${input}"`,
    };
  } catch (err) {
    return couldnt('other', sourceUrl, err?.message || err);
  }
}
