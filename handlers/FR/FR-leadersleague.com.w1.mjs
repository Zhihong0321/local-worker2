export const meta = {
  task: 'FR-leadersleague.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'city', 'slug', 'is_firm', 'ranking_count', 'has_page', 'profile_url'],
  canary: { found: 'Gide Loyrette Nouel', not_found: 'Cabinet Vexalor Conseil' },
};

// The site's own search (the box behind /fr/classements): a JSON API on api.leadersleague.com.
// It answers 20 results per page whatever perpage says, so pages are read until one adds nothing new.
const API = 'https://api.leadersleague.com/firm-search/aggregate';
const SITE = 'https://www.leadersleague.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGES = 10;
const STOP_NEW_PAGE_AFTER_MS = 30000; // keeps the whole call well under 60 s

// Legal forms, removed only at the end of a name (French and common foreign forms). "& Co" is kept on purpose.
const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'eurl', 'sa', 'snc', 'sci', 'scop', 'selarl', 'selas', 'scp', 'sca',
  'earl', 'gie', 'sel', 'gmbh', 'ag', 'bv', 'nv', 'sl', 'srl', 'spa', 'llc', 'ltd', 'plc', 'inc', 'limited', 'llp', 'lp']);

function fold(str) {
  return (str || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The name without a "(city)" part and without a trailing legal form. */
function displayName(str) {
  const words = (str || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(fold(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

/** Match key: case, accents and punctuation folded, trailing legal form removed, a "(city)" tag kept as part of the name. */
function keyOf(str) {
  const m = (str || '').trim().match(/^(.*?)\s*(\([^()]*\))?\s*$/);
  const head = m ? m[1] : (str || '');
  const tail = m && m[2] ? m[2] : '';
  const words = head.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(fold(words[words.length - 1]))) words.pop();
  return fold(`${words.join(' ')} ${tail}`);
}

function cityOf(str) {
  const m = (str || '').match(/\(([^)]*)\)/);
  return m ? m[1].trim() : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node 24 on Windows can abort on process exit while a keep-alive socket from the last fetch is still closing.
  // A short pause lets the sockets settle before the runner exits; the answer itself is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function search(keyword) {
  let source = API;
  try {
    const term = displayName(String(keyword || ''));
    const key = keyOf(String(keyword || ''));
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty company name' };
    }
    source = `${API}?page=1&perpage=20&q=${encodeURIComponent(term)}`;

    const started = Date.now();
    const items = [];
    const seen = new Set();
    let complete = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > STOP_NEW_PAGE_AFTER_MS) break;
      const url = `${API}?page=${page}&perpage=20&q=${encodeURIComponent(term)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'X-App-Context': 'site' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      let data;
      try {
        data = await res.json();
      } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'response is not JSON' };
      }
      if (!Array.isArray(data) || data.some((it) => !it || typeof it.name !== 'string')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: JSON.stringify(data).slice(0, 300) };
      }
      let fresh = 0;
      for (const it of data) {
        const id = it.uuid || it.slug || it.name;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push(it);
        fresh++;
      }
      if (fresh === 0) { complete = true; break; }
    }

    const matches = items.filter((it) => keyOf(it.name) === key);

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((it) => ({
          name: it.name,
          city: cityOf(it.name),
          slug: it.slug || '',
          is_firm: !!it.isFirm,
          ranking_count: it.rankingCount ?? null,
          has_page: !!it.hasPage,
          profile_url: it.hasPage && it.slug ? `${SITE}/fr/firm/${it.slug}` : '',
        })),
        source_url: source,
        excerpt: `Leaders League firm search "${term}": ${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} with this name`,
      };
    }

    if (!complete) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: source,
        excerpt: `search "${term}" has more results than were read (${items.length} read); no exact match among them`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: source,
      excerpt: `Leaders League firm search "${term}": ${items.length} result(s), none with this name`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: source,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
