export const meta = { task: 'CA-urbantoronto.ca', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['thread_title', 'forum', 'date', 'post_url', 'excerpt'],
  canary: { found: 'Tridel', not_found: 'Zéphyrvelle Immobilier' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LEGAL = new Set(['inc', 'incorporated', 'ltd', 'limited', 'ltee', 'limitee', 'corp', 'corporation', 'co', 'company', 'llc', 'lp', 'ulc']);

/** Lowercase, drop accents and punctuation, single spaces. */
function norm(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Plain text of an HTML fragment, URLs removed, entities decoded. */
function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** The company name without its legal form at the end ("ACME TRADING SDN BHD" style, here "Tridel Inc." -> "tridel"). */
function coreName(keyword) {
  const tokens = norm(keyword).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the keep-alive socket finish closing before the worker process exits (Node on Windows aborts otherwise).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  let searchUrl = '';
  try {
    const core = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }
    // Quoted = exact phrase on the forum's own search.
    searchUrl = `https://urbantoronto.ca/forum/search/search?keywords=${encodeURIComponent('"' + core + '"')}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    const finalUrl = res.url || searchUrl;

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: finalUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: finalUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const noResults = /No results found/i.test(html);
    const rows = html.split('<li class="block-row').slice(1);
    // The forum's pages always load a captcha script, so a bot check is only assumed when there are no results to read.
    if (!noResults && rows.length === 0) {
      if (/cf-chl|challenge-platform|Just a moment|h-captcha-response|searching too (quickly|fast)|too many (searches|requests)/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: finalUrl, excerpt: 'bot check or rate limit page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: finalUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    if (noResults && rows.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: finalUrl, excerpt: `No results found for "${core}"` };
    }

    const records = [];
    for (const row of rows) {
      const titleMatch = row.match(/<h3 class="contentRow-title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/);
      if (!titleMatch) continue;
      const title = cleanText(titleMatch[2]);
      const snippet = cleanText((row.match(/<div class="contentRow-snippet">([\s\S]*?)<\/div>/) || [])[1]);
      const date = ((row.match(/datetime="([^"]+)"/) || [])[1]) || '';
      const forum = cleanText((row.match(/Forum:\s*<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
      // Match on the text a person reads: title and snippet, with links removed.
      const readable = ' ' + norm((title + ' ' + snippet).replace(/https?:\/\/\S+/g, ' ')) + ' ';
      if (readable.includes(' ' + core + ' ')) {
        records.push({
          thread_title: title,
          forum,
          date,
          post_url: new URL(titleMatch[1], 'https://urbantoronto.ca').href,
          excerpt: snippet.slice(0, 300),
        });
      }
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: finalUrl,
        excerpt: `${rows.length} results for "${core}", none with the name as written` };
    }
    return { status: 'found', reason: '', records: records.slice(0, 10), source_url: finalUrl,
      excerpt: `${records.length} forum post(s) mention "${core}"; first: ${records[0].thread_title}`.slice(0, 500) };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
