export const meta = {
  task: 'IN-tradingqna.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'url', 'created_at', 'posts_count', 'category_id', 'blurb', 'matched_name', 'type'],
  canary: { found: 'Reliance Industries Ltd', not_found: 'अनजाना उद्योग लिमिटड' },
};

// TradingQ&A is a Discourse forum. Its public search (search.json) returns discussion threads, not company
// registry records. A thread counts as a match only when the company name (legal form removed) appears in its
// title or its preview text, as a whole phrase.

const SITE = 'https://tradingqna.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc', 'opc', 'llc', 'sdn', 'bhd', 'berhad', 'gmbh']);
const MAX_RECORDS = 25;

function normalize(str) {
  // \p{M} keeps Devanagari vowel signs and virama, which are combining marks, not letters.
  return String(str || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** The company name without the legal form, normalised: "Reliance Industries Limited" -> "reliance industries". */
function coreName(keyword) {
  return normalize(keyword).split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

function containsPhrase(text, phrase) {
  return ` ${normalize(text)} `.includes(` ${phrase} `);
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // On Windows Node 24, the runner's process.exit() right after a fetch to this host aborts the process (exit 127)
  // before the socket closes. A short pause lets the socket close first; it costs 2 s of the 60 s budget.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return result;
}

async function lookupOnce(keyword) {
  let core = '';
  let pageUrl = `${SITE}/search`;
  try {
    core = coreName(keyword);
    if (!core) return fail('other', pageUrl, 'no company name was given');

    const query = encodeURIComponent(`"${core}"`);
    pageUrl = `${SITE}/search?q=${query}`;
    const jsonUrl = `${SITE}/search.json?q=${query}`;

    const res = await fetch(jsonUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    const body = await res.text();

    if (res.status === 403 || res.status === 429) return fail('blocked', pageUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', pageUrl, `HTTP ${res.status}`);

    if (body.trimStart().startsWith('<')) {
      const challenge = /captcha|challenge|just a moment|verify you are human/i.test(body);
      return fail(challenge ? 'blocked' : 'layout_changed', pageUrl, body.slice(0, 200));
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return fail('layout_changed', pageUrl, 'search response is not JSON');
    }
    // An empty result comes back with "posts": [] and no "topics" key, so only "posts" is required.
    if (!data || !Array.isArray(data.posts)) {
      return fail('layout_changed', pageUrl, 'search response has no posts list');
    }
    const searchError = data.grouped_search_result && data.grouped_search_result.error;
    if (searchError) return fail('other', pageUrl, `search error: ${searchError}`);

    const topicList = Array.isArray(data.topics) ? data.topics : [];
    const topics = new Map(topicList.map((t) => [t.id, t]));
    const seen = new Set();
    const records = [];
    for (const post of data.posts) {
      const topic = topics.get(post.topic_id);
      if (!topic || seen.has(topic.id)) continue;
      const title = topic.title || '';
      const blurb = post.blurb || '';
      if (!containsPhrase(title, core) && !containsPhrase(blurb, core)) continue;
      seen.add(topic.id);
      records.push({
        title,
        url: `${SITE}/t/${topic.slug}/${topic.id}`,
        created_at: topic.created_at || '',
        posts_count: topic.posts_count ?? null,
        category_id: topic.category_id ?? null,
        blurb,
        matched_name: core,
        type: 'forum_thread',
      });
      if (records.length >= MAX_RECORDS) break;
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: pageUrl,
        excerpt: `0 threads on tradingqna.com mention "${core}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: pageUrl,
      excerpt: `${records.length} thread(s) on tradingqna.com mention "${core}". First: ${records[0].title}`.slice(0, 300),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', pageUrl, String((err && err.message) || err));
  }
}
