export const meta = {
  task: 'KR-nextunicorn.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'company_type', 'summary', 'looking_for_investment', 'profile_url'],
  canary: { found: '프레임웍스(주)', not_found: '존재하지않는가상회사주식회사' },
};

const SITE = 'https://www.nextunicorn.kr';
// The site's own company search (the same JSON the search box uses): startups and investors are two lists.
const ENDPOINTS = ['/api/startup-companies', '/api/investment-companies'];
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const DEADLINE_MS = 45000; // the whole call must finish in under 60 s
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal forms in Korean and English, removed before comparing names.
const LEGAL_FORMS = [
  /\(주\)/g, /주식회사/g, /\(유\)/g, /유한회사/g, /\(사\)/g, /사단법인/g, /\(재\)/g, /재단법인/g,
  /\b(co\s*,?\s*ltd|corporation|corp|inc|ltd|limited|llc|pte|company|co)\b\.?/gi,
];

/** The name with legal form and punctuation removed, single spaces. */
function core(s) {
  let t = String(s || '').normalize('NFKC');
  for (const re of LEGAL_FORMS) t = t.replace(re, ' ');
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

/** Comparison key: core name, lower case, no spaces. */
function key(s) {
  return core(s).replace(/ /g, '').toLowerCase();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Reads every page of one list for one query. Returns { items } or { error } (an answer for the caller). */
async function readList(endpoint, query, deadline) {
  const items = [];
  let after = null;
  let firstUrl = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > deadline) return { error: { reason: 'timeout', url: firstUrl, excerpt: 'the lookup ran out of time' } };
    const u = new URL(SITE + endpoint);
    u.searchParams.set('size', String(PAGE_SIZE));
    u.searchParams.set('query', query);
    if (after) u.searchParams.set('after', after);
    if (!firstUrl) firstUrl = u.href;

    let res;
    try {
      res = await fetch(u.href, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': SITE + '/search',
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { error: { reason: timeout ? 'timeout' : 'other', url: u.href, excerpt: String(err?.message || err) } };
    }

    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { error: { reason: 'blocked', url: u.href, excerpt: `HTTP ${res.status}` } };
    }
    if (!res.ok) {
      return { error: { reason: 'http_error', url: u.href, excerpt: `HTTP ${res.status}` } };
    }
    if (/captcha|challenge|access denied/i.test(text.slice(0, 2000)) && !text.trimStart().startsWith('{')) {
      return { error: { reason: 'blocked', url: u.href, excerpt: text.slice(0, 300) } };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: { reason: 'layout_changed', url: u.href, excerpt: text.slice(0, 300) } };
    }
    if (!json || !Array.isArray(json.data) || typeof json.paging !== 'object') {
      return { error: { reason: 'layout_changed', url: u.href, excerpt: text.slice(0, 300) } };
    }

    items.push(...json.data);
    after = json.paging.next || null;
    if (!after) return { items, url: firstUrl };
  }
  return { error: { reason: 'other', url: firstUrl, excerpt: `more than ${MAX_PAGES * PAGE_SIZE} results for "${query}"; not all were read` } };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const input = String(keyword || '').trim();
    const k = key(input);
    if (!k) return fail('other', SITE + '/search', 'no company name was given after removing the legal form');

    // Query with the core name as typed; if that finds nothing, retry with the spaces removed too.
    const queries = [core(input)];
    const compact = core(input).replace(/ /g, '');
    if (compact && compact !== core(input)) queries.push(compact);

    const deadline = Date.now() + DEADLINE_MS;
    let firstError = null;

    for (const query of queries) {
      const lists = await Promise.all(ENDPOINTS.map((ep) => readList(ep, query, deadline)));
      const matches = [];
      lists.forEach((list, i) => {
        if (list.error) {
          if (!firstError) firstError = list.error;
          return;
        }
        for (const item of list.items) {
          if (!item || typeof item.name !== 'string') continue;
          if (key(item.name) !== k) continue;
          matches.push({
            endpoint: ENDPOINTS[i],
            url: list.url,
            record: {
              name: item.name,
              company_id: item.id || '',
              company_type: item.companyType || (ENDPOINTS[i].includes('investment') ? 'investment' : 'startup'),
              summary: item.summary || '',
              looking_for_investment: item.lookingForInvestment ?? null,
              profile_url: item.id ? `${SITE}/company/${item.id}` : '',
            },
          });
        }
      });

      if (matches.length) {
        const seen = new Set();
        const records = [];
        for (const m of matches) {
          const id = m.record.company_id || m.record.name;
          if (seen.has(id)) continue;
          seen.add(id);
          records.push(m.record);
        }
        const first = records[0];
        return {
          status: 'found',
          reason: '',
          records,
          source_url: matches[0].url,
          excerpt: `${first.name} (${first.company_type}): ${first.summary}`.slice(0, 300),
        };
      }
      // Nothing matched on this query: a failed list means we cannot say "not listed".
      if (firstError) break;
    }

    if (firstError) return fail(firstError.reason, firstError.url, firstError.excerpt);

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${SITE}${ENDPOINTS[0]}?size=${PAGE_SIZE}&query=${encodeURIComponent(core(input))}`,
      excerpt: `no startup or investor named "${core(input)}" in the site's company search`,
    };
  } catch (err) {
    return fail('other', SITE + '/search', String(err?.message || err));
  }
}
