export const meta = {
  task: 'AE-reachuae.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'h1'],
  canary: { found: 'ATLAS METALS LLC', not_found: 'شركة وهمية غير موجودة' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://api.reachuae.com/api/keyword/';
const SITE = 'https://www.reachuae.com';
const LIMIT = 100;
const MAX_PAGES = 5;
const DEADLINE_MS = 50000;

// Legal-form words. The site's keyword search does not match them ("ATLAS METALS LLC" returns nothing, "atlas metals" finds it),
// so they are removed from the search text and from both sides of the title comparison.
const LEGAL_FORMS = new Set([
  'llc', 'fze', 'fzc', 'fzco', 'fz', 'co', 'ltd', 'limited', 'llp', 'spc', 'inc', 'corp', 'corporation',
  'pjsc', 'psc', 'branch', 'sole', 'proprietorship', 'establishment', 'est', 'gmbh', 'pvt', 'plc',
]);

function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&amp;/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** "ATLAS METALS LLC" -> "atlas metals". Only leading/trailing legal-form words are removed. */
function coreName(str) {
  const words = normalize(str).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && LEGAL_FORMS.has(words[0])) words.shift();
  return words.join(' ');
}

/**
 * The keyword API finds a long multi-word name only sometimes ("build care" finds BUILD CARE INTERNATIONAL GENERAL
 * TRADING LLC SPC, "build care international general trading" finds nothing), so the search is tried with shorter
 * word prefixes, longest first.
 */
function searchTerms(core) {
  const words = core.split(' ');
  const terms = [core];
  if (words.length > 2) terms.push(words.slice(0, 2).join(' '));
  if (words.length > 1) terms.push(words[0]);
  return [...new Set(terms)];
}

function cleanText(str) {
  return String(str || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Origin': SITE, 'Referer': SITE + '/' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status}`, url };
  if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status}`, url };
  const text = await res.text();
  try {
    return { json: JSON.parse(text), url };
  } catch {
    return { fail: 'layout_changed', detail: text.slice(0, 300), url };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const core = coreName(keyword);
  const firstUrl = `${API}${encodeURIComponent(core)}?page=1&limit=${LIMIT}`;
  try {
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'no searchable name' };
    }

    const want = normalize(core);
    const matches = [];
    let lastUrl = firstUrl;
    let truncated = false;

    for (const term of searchTerms(core)) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        if (Date.now() - started > DEADLINE_MS) {
          return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: lastUrl, excerpt: 'lookup ran out of time before all results were read' };
        }
        if (page > MAX_PAGES) {
          truncated = true;
          break;
        }
        const url = `${API}${encodeURIComponent(term)}?page=${page}&limit=${LIMIT}`;
        lastUrl = url;
        const got = await getJson(url);
        if (got.fail) {
          return { status: 'couldnt_check', reason: got.fail, records: [], source_url: url, excerpt: got.detail };
        }
        const body = got.json;
        const data = body && body.data;
        if (!body || body.statusCode !== 200 || !data || !Array.isArray(data.data)) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: JSON.stringify(body).slice(0, 300) };
        }

        for (const item of data.data) {
          const title = cleanText(item.title);
          if (!title) continue;
          if (coreName(title) === want) {
            matches.push({ name: title, company_id: item.id, h1: cleanText(item.h1) });
          }
        }

        totalPages = Number(data.meta && data.meta.totalPages) || 1;
        page += 1;
      }
      if (matches.length) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: lastUrl,
        excerpt: `${matches.length} listing(s) titled "${matches[0].name}" on ReachUAE`,
      };
    }

    // Not claimed as not_found when a search had more pages than were read: the company could be on an unread page.
    if (truncated) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl, excerpt: `too many keyword results to read all of them for "${core}"` };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `ReachUAE keyword search read for "${core}" (${searchTerms(core).join(' | ')}): no company title matches`,
    };
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: aborted ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
