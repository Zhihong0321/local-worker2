export const meta = { task: 'IN-forum.valuepickr.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'topic_id', 'url', 'category_id', 'posts_count', 'created_at', 'last_posted_at'],
  canary: { found: 'Kitex Garments Limited', not_found: 'श्री नकली उद्योग प्राइवेट लिमिटेड' } };

// ValuePickr is a Discourse forum. A company is "on the site" when a forum topic is about it, i.e. its TITLE names it
// (for example "Kitex Garments Limited"). Mentions inside replies do not count.
const BASE = 'https://forum.valuepickr.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'pvt', 'private', 'llp', 'inc', 'corp', 'corporation',
  'लिमिटेड', 'प्राइवेट', 'लि', 'प्रा']);
const MAX_PAGES = 3;
const PAGE_BUDGET_MS = 30000;

/** Lower-case word tokens. Letters, combining marks (Devanagari vowel signs) and digits are kept. */
function tokens(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** The company name without its legal form, e.g. "KITEX GARMENTS LTD." -> ["kitex", "garments"]. */
function coreTokens(keyword) {
  return tokens(keyword).filter((t) => !LEGAL_FORMS.has(t));
}

/** True when needle appears as a whole-word run inside hay. */
function hasSequence(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node 24 on Windows can crash on process.exit while a fetch socket is still closing (libuv assertion, exit 127).
  // A short pause after the last request lets the socket close first. The answer itself is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function search(keyword) {
  const started = Date.now();
  try {
    const core = coreTokens(keyword);
    const queryText = `"${core.join(' ')}" in:title`;
    const sourceUrl = `${BASE}/search?q=${encodeURIComponent(queryText)}`;
    if (!core.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'no company name left after removing the legal form' };
    }

    const matches = [];
    const seen = new Set();
    let categoryNames = {};

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > PAGE_BUDGET_MS) break;
      const url = `${BASE}/search.json?q=${encodeURIComponent(queryText)}${page > 1 ? `&page=${page}` : ''}`;

      let res;
      let text;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
          signal: AbortSignal.timeout(25000),
        });
        text = await res.text();
      } catch (err) {
        return { status: 'couldnt_check', reason: isTimeout(err) ? 'timeout' : 'other', records: [], source_url: sourceUrl,
                 excerpt: String(err?.message || err).slice(0, 300) };
      }

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // Only bot-check markers. Discourse pages mention "captcha" in their settings, so that word is not a marker.
        const blocked = /just a moment|cf-chl|challenge-platform|cf-mitigated/i.test(text);
        return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url: sourceUrl,
                 excerpt: text.slice(0, 300) };
      }

      // Discourse always sends grouped_search_result when the search ran. Without it the page is not what we expect.
      if (!data || typeof data !== 'object' || !data.grouped_search_result) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: text.slice(0, 300) };
      }

      for (const c of Array.isArray(data.categories) ? data.categories : []) {
        categoryNames[c.id] = c.name;
      }
      const topics = Array.isArray(data.topics) ? data.topics : [];
      for (const t of topics) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        if (hasSequence(tokens(t.title), core)) matches.push(t);
      }

      if (!data.grouped_search_result.more_full_page_results) break;
    }

    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `No forum topic title contains "${core.join(' ')}"`,
      };
    }

    const records = matches.map((t) => ({
      name: t.title,
      topic_id: t.id,
      url: t.slug ? `${BASE}/t/${t.slug}/${t.id}` : `${BASE}/t/${t.id}`,
      category_id: t.category_id ?? null,
      posts_count: t.posts_count ?? null,
      created_at: t.created_at || '',
      last_posted_at: t.last_posted_at || '',
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: records.map((r) => r.name).slice(0, 5).join(' | ').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
