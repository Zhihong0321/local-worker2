export const meta = { task: 'US-techcrunch.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'title', 'url', 'date', 'matched_in'],
  canary: { found: 'Stripe', not_found: 'Qorvexa Dynamics Inc' } };

// TechCrunch is a news site: a "found" means TechCrunch has articles about the company (a tag with that exact
// name, or an article whose headline names it). It is not a company register.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://techcrunch.com/wp-json/wp/v2';
const POST_FIELDS = '_fields=id,date,link,title,excerpt';
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc',
  'gmbh', 'ag', 'sa', 'lp', 'llp', 'pllc', 'pte', 'pty', 'sdn', 'bhd', 'lc']);
const MAX_PAGES = 10;          // 1,000 search hits at most
const BUDGET_MS = 40000;       // stop paging well before the 60 s limit

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Normalised word list: case, accents kept, punctuation dropped, possessive "'s" dropped. */
function tokens(s) {
  return decode(s).replace(/['’]s\b/gi, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The search text: the name as typed, minus commas, full stops and a trailing legal form. */
function cleanQuery(keyword) {
  const words = String(keyword || '').replace(/[,.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length && LEGAL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

function hasPhrase(hay, needle) {
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

const sameName = (a, needle) => {
  const t = tokens(a);
  return t.length === needle.length && hasPhrase(t, needle);
};

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** GET one JSON endpoint. Returns { ok: true, data, total } or { ok: false, result } with the couldnt_check answer. */
async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept': 'application/json' },
    signal: AbortSignal.timeout(25000)
  });
  if (res.status === 403 || res.status === 429) {
    return { ok: false, result: fail('blocked', url, `HTTP ${res.status}`) };
  }
  if (!res.ok) {
    return { ok: false, result: fail('http_error', url, `HTTP ${res.status}`) };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (/challenges\.cloudflare\.com|cf-chl|turnstile/i.test(text)) {
      return { ok: false, result: fail('blocked', url, 'bot check page instead of JSON') };
    }
    return { ok: false, result: fail('layout_changed', url, text.slice(0, 300)) };
  }
  if (!Array.isArray(data)) {
    return { ok: false, result: fail('layout_changed', url, JSON.stringify(data).slice(0, 300)) };
  }
  return { ok: true, data, total: Number(res.headers.get('x-wp-total')) || data.length };
}

// Headline only: summaries mention many companies in passing (e.g. event ads), so they gave false matches.
function matchedIn(post, needle) {
  return hasPhrase(tokens(post?.title?.rendered), needle) ? 'title' : null;
}

const toRecord = (post, name, matched_in) => ({
  name,
  title: decode(post?.title?.rendered),
  url: post?.link || '',
  date: post?.date || '',
  matched_in
});

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const query = cleanQuery(keyword);
    const needle = tokens(query);
    if (!needle.length) {
      return fail('other', '', 'no company name left to search after removing the legal form');
    }

    // Step 1: a TechCrunch tag with exactly this name (company tags collect that company's articles).
    const tagsUrl = `${API}/tags?search=${encodeURIComponent(query)}&per_page=100&_fields=id,name,link,count`;
    const tags = await getJson(tagsUrl);
    if (!tags.ok) return tags.result;
    const tag = tags.data.find((t) => t && t.count > 0 && sameName(t.name, needle));

    if (tag) {
      const postsUrl = `${API}/posts?tags=${tag.id}&per_page=100&${POST_FIELDS}`;
      const posts = await getJson(postsUrl);
      if (!posts.ok) return posts.result;
      if (posts.data.length) {
        const records = posts.data.map((p) => toRecord(p, query, 'tag'));
        return {
          status: 'found', reason: '', records,
          source_url: tag.link || postsUrl,
          excerpt: `TechCrunch tag "${decode(tag.name)}", ${posts.total} tagged articles. ` +
            records.map((r) => r.title).join(' | ').slice(0, 400)
        };
      }
    }

    // Step 2: article search. The search is not ranked by relevance, so every page (up to the cap) is checked
    // for the name in the headline.
    const searchUrl = `https://techcrunch.com/?s=${encodeURIComponent(query)}`;
    const records = [];
    let total = 0;
    let checked = 0;
    let page = 1;
    let truncated = false;
    for (;;) {
      const r = await getJson(`${API}/posts?search=${encodeURIComponent(query)}&per_page=100&page=${page}&${POST_FIELDS}`);
      if (!r.ok) return r.result;
      total = r.total;
      checked += r.data.length;
      for (const post of r.data) {
        const m = matchedIn(post, needle);
        if (m) records.push(toRecord(post, query, m));
      }
      if (!r.data.length || checked >= total) break;
      if (page >= MAX_PAGES || Date.now() - started > BUDGET_MS) { truncated = true; break; }
      page++;
    }

    if (records.length) {
      return {
        status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: records.map((r) => r.title).join(' | ').slice(0, 500)
      };
    }
    if (truncated) {
      return fail('other', searchUrl,
        `no tag named "${query}"; ${total} search hits, only ${checked} checked and none named it`);
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `no TechCrunch tag named "${query}"; ${total} search hits, none with the name in the headline`
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', `${API}/posts`, String(err?.message || err).slice(0, 300));
  }
}
