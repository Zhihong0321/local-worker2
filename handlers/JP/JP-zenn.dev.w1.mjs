export const meta = {
  task: 'JP-zenn.dev',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'slug', 'url', 'publication_id', 'plan'],
  canary: { found: '株式会社スリーシェイク', not_found: '株式会社ゼロゼロ架空' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://zenn.dev/api/search';
const MAX_PAGES = 3;
const BUDGET_MS = 40000;

// Legal forms, Japanese and common Latin ones. Removed on both sides before comparing.
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|\(合\)|\b(co\.?\s*,?\s*ltd\.?|inc\.?|corporation|corp\.?|llc)(?![a-z])/gi;

function stripLegalForm(str) {
  return String(str || '').normalize('NFKC').replace(LEGAL_FORMS, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(str) {
  return stripLegalForm(str).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function fail(status, reason, sourceUrl, excerpt) {
  return { status, reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  const query = stripLegalForm(kw) || kw;
  const firstUrl = `${API}?q=${encodeURIComponent(query)}&source=publications&order=latest`;

  if (!kwNorm) {
    return fail('couldnt_check', 'other', firstUrl, 'keyword has no name left after removing the legal form');
  }

  try {
    const matches = [];
    let page = 1;
    let scanned = 0;

    while (true) {
      if (page > 1 && Date.now() - started > BUDGET_MS) {
        if (matches.length) break;
        return fail('couldnt_check', 'timeout', firstUrl, `search pages not finished within ${BUDGET_MS / 1000} s`);
      }

      const url = page === 1 ? firstUrl : `${firstUrl}&page=${page}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json,text/plain,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return fail('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return fail('couldnt_check', 'layout_changed', url, text.slice(0, 300));
      }
      if (!json || !Array.isArray(json.publications)) {
        return fail('couldnt_check', 'layout_changed', url, JSON.stringify(json).slice(0, 300));
      }

      scanned += json.publications.length;
      for (const p of json.publications) {
        if (p && normalize(p.display_name) === kwNorm) {
          matches.push({
            name: p.display_name,
            slug: p.name,
            url: `https://zenn.dev/${p.name}`,
            publication_id: p.id,
            plan: p.plan,
          });
        }
      }

      if (json.next_page == null || json.publications.length === 0) break;
      if (page >= MAX_PAGES) {
        if (matches.length) break;
        return fail('couldnt_check', 'other', firstUrl, `more than ${MAX_PAGES} search pages; the handler reads only ${MAX_PAGES}`);
      }
      page += 1;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: matches.map((m) => `${m.name} (zenn.dev/${m.slug})`).join('; ').slice(0, 300),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `Zenn publication search for "${query}" returned ${scanned} publications, none named "${kw}"`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail('couldnt_check', timedOut ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
