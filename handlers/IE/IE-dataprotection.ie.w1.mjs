export const meta = {
  task: 'IE-dataprotection.ie',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'kind', 'url', 'match_in', 'excerpt'],
  canary: { found: 'Ryanair DAC', not_found: 'Comhlacht Dezeno Teoranta' },
};

// The DPC site search (GET /en/search-results?s=...) returns a result count and a list of 10 results per page.
// It is a loose, relevance-ranked search (several words match if any word matches), so the handler searches the
// company's core name and then checks each result title (and its snippet) for the core name as a whole phrase.

const BASE = 'https://www.dataprotection.ie';
const SEARCH_URL = BASE + '/en/search-results';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MAX_PAGES = 10; // read at most the first 100 results
const NO_NEW_PAGE_AFTER_MS = 30000; // one fetch can take up to 25 s, so no new page starts after 30 s

// Legal-form words at the END of a company name, as normalised tokens. Removed before matching.
const LEGAL_FORMS = [
  ['designated', 'activity', 'company'],
  ['public', 'limited', 'company'],
  ['unlimited', 'company'],
  ['limited'], ['ltd'], ['company'], ['dac'], ['uc'], ['plc'], ['inc'], ['llc'],
  ['teoranta'], ['theoranta'], ['teo'], ['cpt'], ['cuideachta'],
];

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };

function decode(s) {
  return String(s || '').replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised word tokens: no accents, no case, no punctuation, possessive 's removed. */
function tokens(str) {
  const s = decode(str).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’‘`]s(?![a-z0-9])/g, '');
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

function stripLegalForm(tok) {
  let t = tok.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (const form of LEGAL_FORMS) {
      const n = form.length;
      if (t.length > n && form.every((w, i) => t[t.length - n + i] === w)) {
        t = t.slice(0, t.length - n);
        changed = true;
        break;
      }
    }
  }
  return t;
}

/** True when `needle` appears in `hay` as a run of whole consecutive tokens. */
function containsPhrase(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function parseCount(html) {
  const m = html.match(/<div class="result-count">[\s\S]*?Results:\s*(\d+)/) || html.match(/Results:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseItems(html) {
  const out = [];
  const re = /<li[^>]*class="result"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const a = body.match(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url;
    try { url = new URL(decode(a[1]), BASE).href.split('#')[0]; } catch { continue; }
    out.push({
      title: cleanText(a[2]),
      excerpt: cleanText(body.replace(a[0], '')),
      url,
    });
  }
  return out;
}

function kindOf(url) {
  if (/\.pdf$/i.test(url)) return 'pdf';
  if (/\/dpc-guidance\/decisions\//.test(url)) return 'decision';
  if (/\/case-studies\//.test(url)) return 'case_study';
  if (/\/news-media\//.test(url)) return 'news';
  return 'page';
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function fetchFailure(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { reason: 'timeout', excerpt: 'no answer within 25 s' };
  return { reason: 'other', excerpt: 'fetch failed: ' + String((e && e.message) || e).slice(0, 200) };
}

function responseProblem(status, text) {
  if (status === 403 || status === 429) return { reason: 'blocked', excerpt: `HTTP ${status}` };
  if (status < 200 || status > 299) return { reason: 'http_error', excerpt: `HTTP ${status}` };
  if (!/result-count/.test(text) && /captcha|just a moment|attention required|cf-chl|access denied|are you a robot/i.test(text)) {
    return { reason: 'blocked', excerpt: 'bot check or captcha page instead of results' };
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let searchUrl = SEARCH_URL;
  const answer = (status, reason, records, excerpt) => ({
    status, reason, records, source_url: searchUrl, excerpt: String(excerpt || '').slice(0, 500),
  });

  try {
    const core = stripLegalForm(tokens(keyword));
    if (!core.length) return answer('couldnt_check', 'other', [], 'no company name left to search after removing the legal form');

    const query = core.join(' ');
    searchUrl = `${SEARCH_URL}?s=${encodeURIComponent(query)}`;

    let first;
    try {
      first = await fetchPage(searchUrl);
    } catch (e) {
      const f = fetchFailure(e);
      return answer('couldnt_check', f.reason, [], f.excerpt);
    }
    const problem = responseProblem(first.status, first.text);
    if (problem) return answer('couldnt_check', problem.reason, [], problem.excerpt);

    const total = parseCount(first.text);
    if (total === null) return answer('couldnt_check', 'layout_changed', [], cleanText(first.text).slice(0, 300));
    if (total === 0) return answer('not_found', '', [], `the site search returned 0 results for "${query}"`);

    const firstItems = parseItems(first.text);
    if (!firstItems.length) return answer('couldnt_check', 'layout_changed', [], cleanText(first.text).slice(0, 300));

    const matches = new Map();
    const collect = (items) => {
      for (const it of items) {
        const inTitle = containsPhrase(tokens(it.title), core);
        const inText = !inTitle && containsPhrase(tokens(it.excerpt), core);
        if (!inTitle && !inText) continue;
        if (matches.has(it.url)) continue;
        matches.set(it.url, {
          name: it.title,
          kind: kindOf(it.url),
          url: it.url,
          match_in: inTitle ? 'title' : 'excerpt',
          excerpt: it.excerpt.slice(0, 300),
        });
      }
    };
    collect(firstItems);

    const pages = Math.ceil(total / PAGE_SIZE);
    const lastPage = Math.min(pages, MAX_PAGES);
    let scanned = 1;
    let stopReason = '';
    let stopExcerpt = '';
    for (let p = 2; p <= lastPage; p++) {
      if (elapsed() > NO_NEW_PAGE_AFTER_MS) {
        stopReason = 'timeout';
        stopExcerpt = `stopped after page ${scanned} of ${pages} to stay under 60 s`;
        break;
      }
      let pg;
      try {
        pg = await fetchPage(`${searchUrl}&p=${p}`);
      } catch (e) {
        const f = fetchFailure(e);
        stopReason = f.reason;
        stopExcerpt = `page ${p}: ${f.excerpt}`;
        break;
      }
      const pr = responseProblem(pg.status, pg.text);
      if (pr) { stopReason = pr.reason; stopExcerpt = `page ${p}: ${pr.excerpt}`; break; }
      const items = parseItems(pg.text);
      if (!items.length) { stopReason = 'layout_changed'; stopExcerpt = `page ${p} has no result items`; break; }
      collect(items);
      scanned = p;
    }

    const records = [...matches.values()];
    if (records.length) {
      return answer('found', '', records, `${records[0].name}: ${records[0].excerpt}`);
    }
    if (scanned === pages) {
      return answer('not_found', '', [], `no result title or snippet names "${query}"; read all ${total} results on ${pages} pages`);
    }
    if (stopReason) {
      return answer('couldnt_check', stopReason, [], `${stopExcerpt}; ${total} results in total, no match in the ${scanned} pages read`);
    }
    return answer('couldnt_check', 'other', [], `only the first ${scanned} pages (${scanned * PAGE_SIZE} of ${total} results) were read; no match`);
  } catch (err) {
    return answer('couldnt_check', 'other', [], String((err && err.message) || err).slice(0, 300));
  }
}
