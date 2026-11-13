export const meta = { task: 'SG-sbr.com.sg', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'url', 'description', 'updated'],
  canary: { found: 'DBS Group Holdings Limited', not_found: 'Syarikat Kuala Tanjung Sdn Bhd' } };

// SBR's public Drupal JSON:API lists every company tag ("taxonomy_term--company") with its name and page alias.
// Anonymous GET, no login. The company names are matched after dropping case, punctuation and legal-form words.
const BASE = 'https://sbr.com.sg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 50;
const MAX_PAGES = 10;        // at most 500 company tags scanned for one search word
const DEADLINE_MS = 50000;   // the whole call must finish under 60 s

const LEGAL_FORMS = new Set(['PTE', 'PRIVATE', 'LTD', 'LIMITED', 'SDN', 'BHD', 'BERHAD', 'PLC', 'INC', 'INCORPORATED',
  'LLP', 'LLC', 'CO', 'COMPANY', 'CORP', 'CORPORATION', 'PT', 'LP']);

/** Upper-case words and digits only, legal-form words dropped from the end. */
function core(name) {
  const t = String(name || '').toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  while (t.length > 1 && LEGAL_FORMS.has(t[t.length - 1])) t.pop();
  return t;
}

function key(name) {
  return core(name).join('');
}

function plainText(value) {
  const html = typeof value === 'string' ? value : (value && typeof value.value === 'string' ? value.value : '');
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&rsquo;|&lsquo;/gi, "'").replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const wanted = key(keyword);
    const words = core(keyword);
    if (!wanted) return fail('other', '', 'the name has no letters or digits to search for');

    // Search by the longest word of the name; the drupal filter ignores case, so every candidate is then compared in full.
    const word = words.reduce((a, b) => (b.length > a.length ? b : a), '');
    const deadline = Date.now() + DEADLINE_MS;
    const matches = [];
    let scanned = 0;

    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        return fail('other', searchUrl, `more than ${MAX_PAGES * PAGE} company tags contain "${word}"; the search was not complete`);
      }
      const url = `${BASE}/jsonapi/taxonomy_term/company?filter[n][condition][path]=name` +
        `&filter[n][condition][operator]=CONTAINS&filter[n][condition][value]=${encodeURIComponent(word)}` +
        `&page[limit]=${PAGE}&page[offset]=${page * PAGE}`;
      searchUrl = url;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail('timeout', searchUrl, 'the lookup ran out of its time budget');

      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/vnd.api+json, application/json;q=0.9, */*;q=0.5' },
        signal: AbortSignal.timeout(Math.min(25000, remaining)),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

      let body;
      try { body = await res.json(); } catch { return fail('layout_changed', searchUrl, 'the answer is not JSON'); }
      if (!body || !Array.isArray(body.data)) return fail('layout_changed', searchUrl, 'the answer has no data list');

      scanned += body.data.length;
      for (const term of body.data) {
        const a = term && term.attributes;
        if (!a || a.status === false) continue;
        if (key(a.name) === wanted) matches.push(a);
      }
      if (body.data.length < PAGE) break;
    }

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 company tags on sbr.com.sg match "${keyword}" (${scanned} checked for "${word}")`,
      };
    }

    const records = matches.map((a) => ({
      name: a.name,
      url: BASE + ((a.path && a.path.alias) || ''),
      description: plainText(a.description).slice(0, 600),
      updated: a.changed || '',
    }));
    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: (records[0].description || records[0].name).slice(0, 300),
    };
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', searchUrl, 'the site did not answer in time');
    return fail('other', searchUrl, String((err && err.message) || err));
  }
}
