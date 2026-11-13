export const meta = { task: 'SG-fccsingapore.com', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'sector', 'country', 'website', 'label'],
  canary: { found: 'FINOVA GROUP', not_found: '新加坡不存在有限公司' } };

const BASE = 'https://www.fccsingapore.com';
const DIRECTORY = '/membership/online-directory.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_PAGES = 4;
const DEADLINE_MS = 50000;

// Legal-form words stripped on both sides before comparing (Singapore company suffixes).
const LEGAL_FORMS = ['pte', 'ltd', 'limited', 'private', 'llp', 'llc', 'inc', 'corp', 'corporation', 'co', 'sdn', 'bhd', 'berhad'];

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&rsquo;|&#039;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case, punctuation removed, legal form words removed. */
function normaliseName(str) {
  const words = decodeEntities(str || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !LEGAL_FORMS.includes(w));
  return kept.join(' ');
}

/** The name without its legal form, used as the search term (the site searches the name text, not the suffix). */
function searchTerm(keyword) {
  const core = normaliseName(keyword);
  return core || cleanText(keyword);
}

function blocked(status, url) {
  return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${status}` };
}

/** Parse one results page: returns { valid, cards, next }. */
function parsePage(html, pageUrl) {
  // The directory form and heading must be there, otherwise the page is not the directory.
  const valid = html.includes('Find a member') && html.includes('Filter by keywords');
  if (!valid) return { valid: false, cards: [], next: null };

  const cards = [];
  const chunks = html.split('box box-bordered').slice(1);
  for (const chunk of chunks) {
    const titleMatch = chunk.match(/<h2 class="title">([\s\S]*?)<\/h2>/);
    if (!titleMatch) continue;
    const name = cleanText(titleMatch[1]);
    const paras = (chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/g) || []).map((p) => p.replace(/^<p[^>]*>|<\/p>$/g, ''));
    const sector = paras[0] !== undefined ? cleanText(paras[0]) : '';
    const country = paras[1] !== undefined && !/<a[\s>]/.test(paras[1]) ? cleanText(paras[1]) : '';
    const siteMatch = chunk.match(/<a href="(https?:\/\/[^"]+)"[^>]*rel="noreferrer"/i) || chunk.match(/<a href="(https?:\/\/[^"]+)"/i);
    const website = siteMatch ? siteMatch[1] : '';
    const label = cleanText((chunk.match(/<span class="label-type[^"]*">([\s\S]*?)<\/span>/) || [])[1] || '');
    if (name) cards.push({ name, sector, country, website, label });
  }

  const nextMatch = html.match(/<a rel="next" href="([^"]+)"/);
  const next = nextMatch ? new URL(decodeEntities(nextMatch[1]), BASE).href : null;
  return { valid: true, cards, next };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startUrl = `${BASE}${DIRECTORY}?tx_obladyannuaire_annuairelist%5Bfilters%5D%5Bsearch%5D=${encodeURIComponent(searchTerm(keyword))}`;
  const started = Date.now();
  try {
    const target = normaliseName(keyword);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: startUrl, excerpt: 'no name left after removing legal form' };
    }

    let url = startUrl;
    let pages = 0;
    let lastBody = '';
    while (url) {
      if (pages >= MAX_PAGES || Date.now() - started > DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: url,
          excerpt: `results continue beyond the ${pages} pages checked; name not confirmed` };
      }
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return blocked(res.status, url);
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      lastBody = html;
      const parsed = parsePage(html, url);
      if (!parsed.valid) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }

      const matches = parsed.cards.filter((c) => normaliseName(c.name) === target);
      if (matches.length) {
        return {
          status: 'found',
          reason: '',
          records: matches.map(({ name, sector, country, website, label }) => ({ name, sector, country, website, label })),
          source_url: url,
          excerpt: matches.map((m) => `${m.name} | ${m.sector} | ${m.country} | ${m.website}`).join(' ; ').slice(0, 500),
        };
      }

      pages += 1;
      url = parsed.next; // null when this was the last page of results
    }

    // Every results page was read, none matched by normalised name.
    const count = (lastBody.match(/([\d,]+) contacts found/) || [])[1] || '0';
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: startUrl,
      excerpt: `Directory search for "${searchTerm(keyword)}" returned ${count} contacts; no company with this name`,
    };
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: aborted ? 'timeout' : 'other',
      records: [],
      source_url: startUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
