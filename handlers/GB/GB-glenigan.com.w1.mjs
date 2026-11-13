export const meta = {
  task: 'GB-glenigan.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['headline', 'date', 'type', 'url'],
  canary: { found: 'Kier', not_found: 'Zorbalux Holdings Ltd' },
};

const BASE = 'https://www.glenigan.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp']);

/** Lower-case words of a name, accents and punctuation removed. "&" becomes "and". */
function tokens(str) {
  return (str || '')
    .replace(/&/g, ' and ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Decode the few HTML entities this site uses in headlines, then strip tags. */
function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#038;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the name's words appear next to each other, in order, inside the headline's words. */
function containsName(headlineTokens, nameTokens) {
  if (nameTokens.length === 0) return false;
  for (let i = 0; i + nameTokens.length <= headlineTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < nameTokens.length; j++) {
      if (headlineTokens[i + j] !== nameTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    // The name without its legal form, and without "and" (the site's search would miss "&" headlines with "and").
    const nameTokens = tokens(keyword).filter((t) => !LEGAL_FORMS.has(t));
    const queryTokens = nameTokens.filter((t) => t !== 'and');
    if (queryTokens.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'the name has no words to search for' };
    }
    searchUrl = `${BASE}/?s=${encodeURIComponent(queryTokens.join(' '))}`;

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const finalUrl = res.url || searchUrl;

    if (/captcha|cf-chl|Just a moment\.\.\./i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: finalUrl, excerpt: 'bot check page' };
    }

    // The site's own answer for an unknown name.
    if (html.includes('Sorry, no results were found')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: finalUrl,
        excerpt: `Glenigan site search for "${queryTokens.join(' ')}": Sorry, no results were found`,
      };
    }

    // Each result is one <div class="card-search"> with a headline, a type, a link and a date.
    const cards = html.split('<div class="card-search">').slice(1);
    const items = [];
    for (const card of cards) {
      const title = card.match(/<p class="content-title">([\s\S]*?)<\/p>/);
      if (!title) continue;
      const type = card.match(/<p class="content-type">([\s\S]*?)<\/p>/);
      const link = card.match(/<a href="([^"]+)"/);
      const date = card.match(/<p class="content-date">([\s\S]*?)<\/p>/);
      items.push({
        headline: cleanText(title[1]),
        type: type ? cleanText(type[1]) : '',
        url: link ? new URL(link[1], BASE).href : '',
        date: date ? cleanText(date[1]) : '',
      });
    }

    if (items.length === 0) {
      if (!html.includes('Search Results') && !html.includes('content-title')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl, excerpt: cleanText(html).slice(0, 300) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl, excerpt: 'search page has no result cards and no "no results" message' };
    }

    // Found only when a headline names the company. Other results are about the search words, not this company.
    const matched = items.filter((it) => containsName(tokens(it.headline), nameTokens));
    if (matched.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: finalUrl,
        excerpt: `site search returned ${items.length} news items, none with "${nameTokens.join(' ')}" in the headline; the article text is not checked`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matched,
      source_url: finalUrl,
      excerpt: matched.map((m) => `${m.date} ${m.headline}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
