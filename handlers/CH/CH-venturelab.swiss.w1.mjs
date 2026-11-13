export const meta = { task: 'CH-venturelab.swiss', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'uid', 'incorporated', 'headquarters', 'sectors', 'website', 'profile_url'],
  canary: { found: 'Amal Therapeutics SA', not_found: 'Zyxqwerte Forschungs AG' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH_URL = (q) => `https://www.venturelab.swiss/index.cfm?page=138873&q=${encodeURIComponent(q)}`;
const MAX_PAGES = 3;          // result pages read per lookup
const START_LIMIT_MS = 30000; // no new fetch after 30 s, so the whole call stays under 60 s
const LEGAL = new Set(['sa', 'ag', 'gmbh', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'corp', 'co', 'plc', 'srl', 'bv', 'ab', 'kg', 'ug', 'se', 'sas', 'spa', 'ltda', 'limited']);

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&ndash;|&#8211;/gi, '-').replace(/&mdash;|&#8212;/gi, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised company core: lower case, no accents or punctuation, trailing legal form removed. */
function core(s) {
  let t = decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/s\.\s*a\./g, 'sa').replace(/s\.\s*r\.\s*l\./g, 'sarl');
  const toks = t.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (toks.length > 1 && LEGAL.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

async function getPage(url, startedAt) {
  if (Date.now() - startedAt > START_LIMIT_MS) return { skipped: true };
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en,de-CH;q=0.8,fr;q=0.6' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text, finalUrl: res.url || url };
}

function absolute(href, base) {
  return new URL(decode(href), base).href;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startedAt = Date.now();
  const searchUrl = SEARCH_URL(String(keyword || '').trim());
  try {
    const wanted = core(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
    }

    const matches = [];
    const seenProfiles = new Set();
    let url = searchUrl;
    let pagesRead = 0;
    let moreResults = false;

    while (url && pagesRead < MAX_PAGES) {
      const page = await getPage(url, startedAt);
      if (page.skipped) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: 'stopped before the 60 s limit' };
      }
      if (page.status === 403 || page.status === 429 || /captcha|cf-chl|just a moment|access denied/i.test(page.text)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${page.status}` };
      }
      if (!page.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${page.status}` };
      }
      pagesRead++;

      const html = page.text;
      const items = [...html.matchAll(/<h4>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>/g)];
      const hasResultsBlock = /vl-search-results|About \d[\d,]* results|No results/i.test(html);
      if (!hasResultsBlock) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }
      if (pagesRead === 1 && items.length === 0 && /No results/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'No results' };
      }

      // A company profile is a result whose title is "<company> - Venturelab Swiss".
      for (const m of items) {
        const href = absolute(m[1], url);
        const title = cleanText(m[2]).replace(/\s*[-–—]\s*Venturelab(\s+Swiss)?\s*$/i, '');
        if (!/venturelab\.swiss/i.test(href) || core(title) !== wanted || seenProfiles.has(href)) continue;
        if (!/Venturelab(\s+Swiss)?\s*$/i.test(cleanText(m[2]))) continue;
        seenProfiles.add(href);

        const prof = await getPage(href, startedAt);
        if (prof.skipped) {
          return { status: 'couldnt_check', reason: 'timeout', records: matches, source_url: href, excerpt: 'stopped before the 60 s limit' };
        }
        if (!prof.ok) {
          return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: href, excerpt: `HTTP ${prof.status}` };
        }
        const ph = prof.text;
        const hdr = ph.match(/<div class="startup-details-header">([\s\S]*?)<div class="startup-details-body">/);
        const h2 = hdr && hdr[1].match(/<h2>([\s\S]*?)<\/h2>/);
        if (!h2) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: href, excerpt: cleanText(ph).slice(0, 300) };
        }
        const name = cleanText(h2[1]);
        if (core(name) !== wanted) continue; // a different company with a similar title

        const uidMatch = ph.match(/<!--\s*(CHE-[\d.]+)\s*-->/);
        const incorporated = ph.match(/<h5>Incorporated<\/h5>\s*<span>([\s\S]*?)<\/span>/);
        const hq = ph.match(/<h5>Headquarters<\/h5>\s*<span>([\s\S]*?)<\/span>/);
        const sectorsBlock = ph.match(/<h3>Sectors<\/h3>([\s\S]*?)<\/div>/);
        const sectors = sectorsBlock ? [...sectorsBlock[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) => cleanText(s[1])) : [];
        const web = ph.match(/<li class="home">\s*<a href="([^"]+)"/);
        matches.push({
          name,
          uid: uidMatch ? uidMatch[1] : '',
          incorporated: incorporated ? cleanText(incorporated[1]) : '',
          headquarters: hq ? cleanText(hq[1]) : '',
          sectors: [...new Set(sectors)],
          website: web ? decode(web[1]) : '',
          profile_url: href,
        });
      }

      // Next result page, if there is one.
      const next = html.match(/<a\s[^>]*href="([^"]+)"[^>]*>\s*Next\s*<\/a>/i);
      url = next ? absolute(next[1], url) : null;
      if (!url) moreResults = false;
      else moreResults = true;
    }

    if (matches.length > 0) {
      return {
        status: 'found', reason: '', records: matches, source_url: searchUrl,
        excerpt: `${matches[0].name}: ${matches[0].incorporated ? 'incorporated ' + matches[0].incorporated + '; ' : ''}${matches[0].headquarters ? 'headquarters ' + matches[0].headquarters : ''}`.trim(),
      };
    }
    if (moreResults) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: `no match in the first ${MAX_PAGES} result pages; more pages exist` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `search read ${pagesRead} page(s); no company profile with this name` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
