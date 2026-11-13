export const meta = {
  task: 'JP-note.com',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'urlname', 'url', 'profile', 'follower_count', 'following_count'],
  canary: { found: 'ネットプロテクションズ', not_found: '株式会社ゼノデゾン' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Japanese legal forms, removed from the start or end of a name before searching and comparing.
const LEGAL_FORMS = ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '相互会社', '(株)', '(有)', '(同)'];

/**
 * note's search matches profile text too, so searching "株式会社X" finds people who work at X and drops X's own
 * account. The search therefore uses the bare name (legal form removed).
 */
function coreName(raw) {
  let s = String(raw || '').normalize('NFKC').trim();
  let prev;
  do {
    prev = s;
    for (const f of LEGAL_FORMS) {
      const nf = f.normalize('NFKC');
      if (s.startsWith(nf)) s = s.slice(nf.length).trim();
      if (s.endsWith(nf)) s = s.slice(0, -nf.length).trim();
    }
    s = s.replace(/[\s,.]*\b(co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|corporation|llc|k\.k\.?|ltd\.?|limited)\.?$/i, '').trim();
  } while (s !== prev);
  return s;
}

/** Comparison key: case, width, spaces and punctuation ignored. */
function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・\-‐-―_.,()\[\]{}【】「」『』'"`]/g, '');
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short wait at the end lets the HTTP connection close before the worker's runner calls process.exit();
 * without it Node 24 on Windows aborts with a libuv assertion (exit code 127) after a fetch.
 */
export default async function lookup(keyword) {
  const answer = await check(keyword);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return answer;
}

async function check(keyword) {
  const core = coreName(keyword);
  const searchPage = `https://note.com/search?q=${encodeURIComponent(core)}&context=user&mode=search`;
  if (!core) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchPage, excerpt: 'empty company name' };
  }
  try {
    const apiUrl = `https://note.com/api/v3/searches?context=user&q=${encodeURIComponent(core)}&size=20`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchPage, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchPage, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (/captcha|challenge-platform|cf-chl/i.test(text.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchPage, excerpt: 'bot check page' };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchPage, excerpt: text.slice(0, 300) };
    }

    const contents = json?.data?.users?.contents;
    if (!Array.isArray(contents)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchPage, excerpt: text.slice(0, 300) };
    }

    // Exact name match only: the account's display name, legal form removed, equals the company name.
    const target = norm(core);
    const hits = contents.filter((u) => norm(coreName(u.nickname)) === target);

    if (hits.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchPage,
        excerpt: `${contents.length} accounts returned for "${core}", none named "${core}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: hits.map((u) => ({
        name: u.nickname,
        urlname: u.urlname,
        url: `https://note.com/${u.urlname}`,
        profile: String(u.profile || '').slice(0, 300),
        follower_count: u.follower_count ?? null,
        following_count: u.following_count ?? null,
      })),
      source_url: searchPage,
      excerpt: `Account "${hits[0].nickname}": ${String(hits[0].profile || '').slice(0, 200)}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchPage,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
