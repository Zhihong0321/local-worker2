export const meta = { task: 'FR-60millions-mag.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'url', 'created_at', 'last_posted_at', 'comment_count'],
  canary: { found: 'Boulanger', not_found: 'Établissements Zyxqwertovna SARL' } };

// The forum is Flarum. Its public discussion search (the same one the site's search box uses) returns JSON without login.
// The search is loose (a multi-word query also returns threads that share one word), so a hit only counts when the
// company's normalised name appears in the thread title.
const SITE = 'https://www.60millions-mag.com';
const API = `${SITE}/forum/api/discussions`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 50;
const MAX_PAGES = 4; // at most 200 search hits read
const LEGAL_FORMS = new Set(['sarl', 'sas', 'sasu', 'sa', 'eurl', 'snc', 'sci', 'scop', 'sca', 'sel', 'sarlu']);

/** Lower case, no accents, every other character becomes a space. */
function fold(str) {
  return String(str || '')
    .replace(/&amp;/gi, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The company name without a trailing legal form ("BOULANGER SA" -> "boulanger"). */
function coreName(keyword) {
  const tokens = fold(keyword).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** True when the title contains the whole normalised name as words ("SAV Boulanger" has "boulanger"). */
function titleNamesCompany(title, core) {
  return (` ${fold(title)} `).includes(` ${core} `);
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const core = coreName(keyword);
    if (!core) return fail('other', SITE + '/forum/', 'empty company name');
    const searchPage = `${SITE}/forum/?q=${encodeURIComponent(core)}`;

    const matches = [];
    let total = 0;
    let truncated = false;

    const started = Date.now();
    for (let page = 0; page < MAX_PAGES; page++) {
      // Stay well under the 60 s limit: no new page after 35 s.
      if (page > 0 && Date.now() - started > 35000) { truncated = true; break; }
      const apiUrl = `${API}?sort=&filter%5Bq%5D=${encodeURIComponent(core)}&page%5Blimit%5D=${PAGE}&page%5Boffset%5D=${page * PAGE}`;
      const getOnce = () => fetch(apiUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/vnd.api+json, application/json;q=0.9, */*;q=0.5' },
        signal: AbortSignal.timeout(25000),
      });
      let res = await getOnce();
      // The site's origin sometimes times out (Cloudflare 522) for a few seconds: one retry before giving up.
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 3000));
        res = await getOnce();
      }

      if (res.status === 403 || res.status === 429) {
        return fail('blocked', searchPage, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return fail('http_error', searchPage, `HTTP ${res.status}`);
      }

      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        const challenge = /captcha|challenge|cf-chl|access denied/i.test(text.slice(0, 5000));
        return fail(challenge ? 'blocked' : 'layout_changed', searchPage, text.slice(0, 200));
      }
      if (!body || !Array.isArray(body.data)) {
        return fail('layout_changed', searchPage, 'no data list in the search response');
      }
      if (body.data.length && !body.data.every((d) => d && d.attributes && typeof d.attributes.title === 'string')) {
        return fail('layout_changed', searchPage, 'search items have no title');
      }

      total += body.data.length;
      for (const d of body.data) {
        const a = d.attributes;
        if (!titleNamesCompany(a.title, core) || !a.slug) continue;
        matches.push({
          name: a.title.trim(),
          url: `${SITE}/forum/d/${a.slug}`,
          created_at: a.createdAt || '',
          last_posted_at: a.lastPostedAt || '',
          comment_count: a.commentCount ?? null,
        });
      }

      if (body.data.length < PAGE) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: searchPage,
        excerpt: `${matches.length} thread(s) with "${core}" in the title, out of ${total} search hits${truncated ? ' (first 200 read)' : ''}`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchPage,
      excerpt: total
        ? `${total} search hits for "${core}", none names it in the title`
        : `0 results for "${core}"`,
    };
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, `${SITE}/forum/`, err && err.message ? err.message : err);
  }
}
