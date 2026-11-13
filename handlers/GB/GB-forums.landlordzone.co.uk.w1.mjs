export const meta = {
  task: 'GB-forums.landlordzone.co.uk',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'space', 'url', 'published_at', 'excerpt'],
  canary: { found: 'Winkworth', not_found: 'Xqzvlorin Holdings Ltd' },
};

const BASE = 'https://forums.landlordzone.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-GB,en;q=0.9' };
// Stop starting new requests after this many ms, so the whole call finishes well inside 60 s.
const DEADLINE_MS = 30000;
const CONCURRENCY = 4;
const MAX_PAGES = 4;
const LEGAL_FORMS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'cic', 'inc', 'llc', 'co', 'company', 'corp', 'corporation']);

/** Lower-case, punctuation removed, words separated by single spaces. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The name without its legal form ("ACME TRADING LTD" -> "acme trading"). */
function coreName(keyword) {
  const words = norm(keyword).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The site's own search matches words anywhere in a post; we only call it a match when the name is in the title, slug or snippet. */
function matchPost(post, core) {
  const visible = [post.display_title || post.name || '', post.slug || '', post.truncated_content || ''].map(norm).join(' ');
  return (' ' + visible + ' ').includes(' ' + core + ' ');
}

async function getJson(url, deadline) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status}`, url };
  if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status}`, url };
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { fail: 'layout_changed', detail: text.slice(0, 200), url }; }
  return { json, url };
}

/** Every page of one space's posts that matches the search term (public, anonymous read). */
async function searchSpace(space, core, deadline) {
  const posts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}/internal_api/spaces/${space.id}/posts?per_page=50&page=${page}&search=${encodeURIComponent(core)}`;
    const r = await getJson(url, deadline);
    if (r.fail) return { fail: r.fail, detail: r.detail, url, space: space.name };
    if (!Array.isArray(r.json?.records)) return { fail: 'layout_changed', detail: 'no records list', url, space: space.name };
    posts.push(...r.json.records);
    if (!r.json.has_next_page || Date.now() > deadline) break;
  }
  return { posts, space: space.name };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const deadline = started + DEADLINE_MS;
  const spacesUrl = `${BASE}/internal_api/spaces`;
  try {
    const core = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: spacesUrl, excerpt: 'empty company name' };
    }

    const list = await getJson(spacesUrl, deadline);
    if (list.fail) {
      return { status: 'couldnt_check', reason: list.fail, records: [], source_url: spacesUrl, excerpt: list.detail };
    }
    if (!Array.isArray(list.json?.records)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: spacesUrl, excerpt: 'no spaces list' };
    }
    // Only spaces that are open to everyone; spaces hidden from non-members are not read.
    const spaces = list.json.records.filter(
      (s) => s && s.visibility === 'open' && !s.is_hidden_from_non_members && (s.posts_count || 0) > 0,
    );

    const hits = [];
    const failures = [];
    let skipped = 0;
    const queue = [...spaces];
    const worker = async () => {
      while (queue.length) {
        if (Date.now() > deadline) { skipped += queue.length; queue.length = 0; return; }
        const space = queue.shift();
        const r = await searchSpace(space, core, deadline);
        if (r.fail) failures.push(r);
        else hits.push(...r.posts);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const matched = [];
    const seen = new Set();
    for (const p of hits) {
      if (seen.has(p.id) || !matchPost(p, core)) continue;
      seen.add(p.id);
      matched.push(p);
    }

    if (matched.length) {
      const records = matched.map((p) => ({
        name: p.display_title || p.name || '',
        space: p.space_name || '',
        url: `${BASE}/c/${p.space_slug}/${p.slug}`,
        published_at: p.published_at || '',
        excerpt: String(p.truncated_content || '').slice(0, 300),
      }));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].url,
        excerpt: `${records.length} post(s) name "${core}": ${records.map((r) => r.name).slice(0, 3).join(' | ')}`.slice(0, 500),
      };
    }

    if (hits.length) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: spacesUrl,
        excerpt: `site search returned ${hits.length} post(s) for "${core}" but the name is not in their titles or snippets; a person has to open them`,
      };
    }

    if (failures.length) {
      const f = failures[0];
      return { status: 'couldnt_check', reason: f.fail, records: [], source_url: f.url, excerpt: `${f.space}: ${f.detail}` };
    }

    if (skipped) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: spacesUrl, excerpt: `${skipped} space(s) not searched within ${DEADLINE_MS / 1000} s` };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: spacesUrl,
      excerpt: `site post-name search over ${spaces.length} open space(s) for "${core}": 0 posts (post bodies are not searched by the site)`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: spacesUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
