export const meta = { task: 'IE-thecurrency.news', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['title', 'date', 'url', 'matched_in'],
  canary: { found: 'Kerry Group', not_found: 'Cuideachta Dezeno Teoranta' } };

// The Currency is a news site. Its public WordPress REST search returns articles; a company "is on the site"
// when an article visibly names it (title or teaser). The records are articles, not registry entries.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = ['limited', 'ltd', 'dac', 'plc', 'teoranta', 'teo', 'unlimited', 'ulc', 'uc', 'clg', 'llp', 'cuideachta', 'comhlacht'];

/** Lower-case words only: tags, entities and punctuation become single spaces. */
function words(s) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Company name without its legal form, e.g. "ACME TRADING SDN BHD" -> ["acme", "trading", "sdn", "bhd"] (only trailing/leading forms removed). */
function coreName(keyword) {
  const w = words(keyword).split(' ').filter(Boolean);
  while (w.length && LEGAL_FORMS.includes(w[w.length - 1])) w.pop();
  while (w.length && LEGAL_FORMS.includes(w[0])) w.shift();
  return w;
}

function decode(s) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function out(status, reason, sourceUrl, excerpt, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await search(keyword);
  // Node on Windows asserts when the runner exits while a just-used socket is still closing; let it settle first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return result;
}

async function search(keyword) {
  let searchUrl = '';
  try {
    const core = coreName(String(keyword || ''));
    if (!core.length) return out('couldnt_check', 'other', '', 'no company name left after removing the legal form');

    const phrase = ' ' + core.join(' ') + ' ';
    searchUrl = 'https://thecurrency.news/wp-json/wp/v2/posts?search=' + encodeURIComponent(core.join(' '))
      + '&per_page=100&_fields=id,title,link,date,content';

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429 || res.headers.get('cf-mitigated') === 'challenge') {
      return out('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}, cf-mitigated=${res.headers.get('cf-mitigated') || ''}`);
    }
    if (!res.ok) {
      return out('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
    }

    const text = await res.text();
    if (/Just a moment|cf-chl|challenge-platform/i.test(text.slice(0, 5000))) {
      return out('couldnt_check', 'blocked', searchUrl, 'Cloudflare challenge page');
    }

    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!Array.isArray(data)) {
      return out('couldnt_check', 'layout_changed', searchUrl, text.slice(0, 300));
    }

    const total = Number(res.headers.get('x-wp-total')) || data.length;
    const matches = [];
    for (const post of data) {
      const title = post?.title?.rendered || '';
      const teaser = post?.content?.rendered || '';
      let matchedIn = '';
      if ((' ' + words(title) + ' ').includes(phrase)) matchedIn = 'title';
      else if ((' ' + words(teaser) + ' ').includes(phrase)) matchedIn = 'teaser';
      if (matchedIn) {
        matches.push({ title: decode(title), date: post.date || '', url: post.link || '', matched_in: matchedIn });
      }
    }

    const shown = `${data.length} article(s) returned by the site search for "${core.join(' ')}" (${total} in total)`;

    if (matches.length === 0) {
      return out('not_found', '', searchUrl, `${shown}; none names the company in its title or teaser`);
    }

    return out('found', '', searchUrl,
      `${matches.length} article(s) on The Currency name "${core.join(' ')}"; ${shown}` +
      (total > data.length ? ' - only the first page was checked' : ''),
      matches);
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return out('couldnt_check', 'timeout', searchUrl, 'the search did not answer within 25 s');
    }
    return out('couldnt_check', 'other', searchUrl, String(err?.message || err).slice(0, 300));
  }
}
