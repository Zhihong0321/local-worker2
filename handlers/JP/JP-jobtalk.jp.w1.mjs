export const meta = {
  task: 'JP-jobtalk.jp',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['id', 'name', 'old_name', 'known_name', 'matched_on', 'pref', 'city', 'industry', 'is_bankrupt', 'display', 'website', 'profile_url', 'evaluate_point', 'review_count'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ゼノデゾ株式会社' },
};

const BASE = 'https://jobtalk.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const MORE_PAGES_BEFORE_MS = 20000;

// Japanese and common English legal-form words, removed before comparing names.
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|特定非営利活動法人|一般社団法人|一般財団法人|公益社団法人|公益財団法人|\(株\)|\(有\)|\(同\)|co\.?\s*,?\s*ltd\.?|inc\.?|corporation|corp\.?|llc\.?/gi;

/** The name with legal form removed, NFKC-normalised and spaces collapsed. Used as the search word. */
function coreName(s) {
  return String(s || '').normalize('NFKC').replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
}

/** Comparison key: core name, lower case, no spaces or punctuation. */
function normName(s) {
  return coreName(s).toLowerCase().replace(/[\s.,・\-()&'"]/g, '');
}

function couldnt(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt || '').slice(0, 300) };
}

function toRecord(n, matchedOn) {
  return {
    id: n.id,
    name: n.name || '',
    old_name: n.oldCompanyName || '',
    known_name: n.commonlyKnownName || '',
    matched_on: matchedOn,
    pref: n.pref?.name || '',
    city: n.city?.name || '',
    industry: n.industry?.name || '',
    is_bankrupt: !!n.isBankrupt,
    display: n.display || '',
    website: n.url || '',
    profile_url: `${BASE}/companies/${n.id}`,
    evaluate_point: n.evaluatePoint ?? null,
    review_count: n.answersSummary?.totalCount ?? null,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await lookupOnce(keyword);
  // Let the HTTP sockets close before the caller can exit the process: on Windows an immediate process.exit()
  // after a fetch can abort Node with a libuv assertion (exit code 127).
  await new Promise((r) => setTimeout(r, 300));
  return out;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const core = coreName(keyword);
  const want = normName(keyword);
  const searchUrl = (page) =>
    `${BASE}/companies/search?keyword=${encodeURIComponent(core)}${page > 1 ? `&page=${page}` : ''}`;
  const firstUrl = searchUrl(1);

  try {
    if (!core || !want) return couldnt('other', firstUrl, 'no company name in the input');

    const matches = [];
    const seen = new Set();
    let totalCount = null;
    let exhausted = false;
    let pagesChecked = 0;
    let lastUrl = firstUrl;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > MORE_PAGES_BEFORE_MS) break;
      const url = searchUrl(page);
      lastUrl = url;

      let res;
      try {
        res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja,en;q=0.5',
          },
          signal: AbortSignal.timeout(25000),
        });
      } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return couldnt(timedOut ? 'timeout' : 'other', url, String(e?.message || e));
      }

      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);
      if (/sign_in/.test(res.url || '')) return couldnt('blocked', url, `redirected to login: ${res.url}`);

      const html = await res.text();
      const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) {
        if (/captcha|cf-challenge|Just a moment/i.test(html)) return couldnt('blocked', url, 'bot check page');
        return couldnt('layout_changed', url, html.slice(0, 200));
      }

      let data;
      try {
        data = JSON.parse(m[1]);
      } catch {
        return couldnt('layout_changed', url, 'embedded JSON did not parse');
      }
      const queries = data?.props?.pageProps?.dehydratedState?.queries;
      const q = Array.isArray(queries)
        ? queries.find((x) => x?.queryKey?.[0] === 'companies' || String(x?.queryHash || '').startsWith('["companies"'))
        : null;
      const conn = q?.state?.data?.companies;
      if (!conn || !Array.isArray(conn.nodes) || typeof conn.pageInfo?.totalCount !== 'number') {
        return couldnt('layout_changed', url, 'no company search data in page');
      }

      totalCount = conn.pageInfo.totalCount;
      pagesChecked++;

      for (const n of conn.nodes) {
        let matchedOn = '';
        if (normName(n.name) === want) matchedOn = 'name';
        else if (normName(n.oldCompanyName) === want) matchedOn = 'old_name';
        else if (normName(n.commonlyKnownName) === want) matchedOn = 'known_name';
        if (!matchedOn || seen.has(n.id)) continue;
        seen.add(n.id);
        matches.push(toRecord(n, matchedOn));
      }

      exhausted = conn.nodes.length === 0 || page * PAGE_SIZE >= totalCount;
      if (exhausted) break;
    }

    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${first.name} | ${first.pref} ${first.city} | ${first.industry} | evaluate ${first.evaluate_point}`.slice(0, 300),
      };
    }

    if (exhausted) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `site search for "${core}" returned ${totalCount} result(s); none has this name`,
      };
    }

    return couldnt('other', lastUrl, `no exact match in the first ${pagesChecked} of ${Math.ceil(totalCount / PAGE_SIZE)} result pages for "${core}"`);
  } catch (err) {
    return couldnt('other', firstUrl, String(err?.message || err));
  }
}
