export const meta = {
  task: 'ES-aepd.es',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['reference', 'pdf_url', 'name_as_written', 'excerpt'],
  canary: { found: 'GLOVOAPP23, S.L.', not_found: 'Empresa Inexistente Zqxv S.L.' },
};

// AEPD site search (Drupal view "solr-general-contents"). Each sanction / decision result is a PDF under /documento/.
// The search result snippet shows the text around the match, so the company name can be checked on the result page.
const SEARCH = 'https://www.aepd.es/buscador';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // 10 hits per page, so at most 50 hits are read
const DEADLINE_MS = 45000;    // stop paging well inside the 60 s limit
const LEGAL = new Set(['sl', 'sa', 'slu', 'sau', 'sll', 'slne', 'scl', 'sc', 'coop', 'ltd', 'llc', 'inc', 'gmbh', 'sro',
  'limitada', 'anonima', 'unipersonal', 'sociedad', 'cooperativa', 's', 'l', 'u', 'a']);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function tokens(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** The company name without its legal form, e.g. "GLOVOAPP23, S.L." -> ["glovoapp23"]. */
function coreTokens(keyword) {
  const t = tokens(keyword);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

/** True when the words of the name appear in the same order, next to each other, in the text. */
function containsRun(hay, needle) {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** The name as the site writes it (case, punctuation and legal form kept), or '' when it cannot be cut out. */
function spanAsWritten(text, core) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(core.map(esc).join('[^a-z0-9]+') +
    '(?:[\\s,.]+(?:s\\.?\\s?a\\.?u?|s\\.?\\s?l\\.?u?|s\\.?\\s?l\\.?l\\.?|slne|s\\.?\\s?coop\\.?))?', 'i');
  const m = text.match(re);
  return m ? m[0].trim() : '';
}

/** Splits the results page into hits: title (reference), snippet text and the PDF link. */
function parseRows(html) {
  const rows = [];
  for (const chunk of html.split('<div class="views-row">').slice(1)) {
    const title = cleanText((chunk.match(/field--name-title"><h2>([\s\S]*?)<\/h2>/) || [])[1]);
    let bodyPart = (chunk.split('field--name-body')[1] || '');
    bodyPart = bodyPart.replace(/^[^>]*>/, '').split('<a ')[0];
    const pdf = (chunk.match(/href="([^"]*\/documento\/[^"]*?\.pdf)"/i) || [])[1] || '';
    rows.push({ title, body: cleanText(bodyPart), pdf });
  }
  return rows;
}

function answer(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const core = coreTokens(keyword);
    if (core.length === 0) return answer('couldnt_check', 'other', SEARCH, 'empty company name');

    const searchUrl = `${SEARCH}?search=${encodeURIComponent(core.join(' '))}`;
    const records = [];
    let hitsSeen = 0;
    let sawEmpty = false;
    let morePages = false;
    let pagesRead = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - started > DEADLINE_MS) break;
      const url = page === 0 ? searchUrl : `${searchUrl}&page=${page}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return answer('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return answer('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
      }
      const html = await res.text();
      if (/captcha|challenge-platform|cf-chl/i.test(html)) {
        return answer('couldnt_check', 'blocked', url, 'bot check page');
      }
      if (!html.includes('view-solr-general-contents') || !html.includes('name="search"')) {
        return answer('couldnt_check', 'layout_changed', url, html.slice(0, 300));
      }
      pagesRead++;
      if (html.includes('view-empty') && !html.includes('<div class="views-row">')) {
        sawEmpty = true;
        break;
      }
      const rows = parseRows(html);
      if (rows.length === 0) {
        return answer('couldnt_check', 'layout_changed', url, 'results area without hits: ' + html.slice(0, 200));
      }
      hitsSeen += rows.length;
      for (const r of rows) {
        if (!r.pdf || !containsRun(tokens(r.body), core)) continue;
        records.push({
          reference: r.title,
          pdf_url: new URL(r.pdf, SEARCH).href,
          name_as_written: spanAsWritten(r.body, core),
          excerpt: r.body.slice(0, 300),
        });
      }
      morePages = html.includes('pager__item--next');
      if (!morePages) break;
    }

    if (records.length > 0) {
      const note = morePages ? ` (first ${pagesRead} page(s) of more hits checked)` : '';
      return answer('found', '', searchUrl, `${records.length} AEPD document(s) whose text names this company${note}`, records);
    }
    if (sawEmpty && hitsSeen === 0) {
      return answer('not_found', '', searchUrl, 'AEPD site search: 0 results');
    }
    if (morePages) {
      return answer('couldnt_check', 'other', searchUrl,
        `${hitsSeen} hits read, name not in them; more hits exist beyond page ${pagesRead}`);
    }
    return answer('couldnt_check', 'other', searchUrl,
      `${hitsSeen} AEPD hit(s) for the search words, but no result shows this name in its text`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timeout ? 'timeout' : 'other',
      `${SEARCH}?search=${encodeURIComponent(String(keyword || ''))}`, String(err?.message || err));
  }
}
