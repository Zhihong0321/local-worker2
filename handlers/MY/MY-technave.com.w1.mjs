export const meta = {
  task: 'MY-technave.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'url', 'tags', 'matched_name'],
  canary: { found: 'Urban Republic', not_found: 'Syarikat Fiktif Tiada Rekod Sdn Bhd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://technave.com/';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', rsquo: '’', lsquo: '‘', ndash: '-', mdash: '-' };

function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Letters and digits only, lower case: "Urban Republic, senQ" -> "urbanrepublicsenq"
function norm(s) {
  return decode(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Remove brackets and Malaysian legal-form words so the search uses the trading name.
// "URBAN REPUBLIC (M) SDN. BHD." -> "URBAN REPUBLIC"
function coreName(keyword) {
  return (keyword || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(?<!\p{L})(sdn|bhd|berhad|plt|llp|ltd|pte)\.?(?!\p{L})/giu, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = BASE + 'index.php?app=gadget';
  try {
    const core = coreName(keyword);
    if (!core || !norm(core)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name after removing legal form' };
    }
    searchUrl = `${BASE}index.php?app=gadget&query=${encodeURIComponent(core)}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/cf-chl|captcha|Just a moment|Attention Required/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot or captcha page' };
    }

    // The search page template: its own search form and the "keyword:" marker.
    const isSearchPage = html.includes('action="index.php?app=gadget"') && html.includes('keyword:');
    const items = html.match(/<li class="articlelist">[\s\S]*?<\/li>/g) || [];
    const hasHeading = html.includes('News &amp; Reviews:');

    if (!isSearchPage) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    if (items.length === 0) {
      if (hasHeading) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: 'results heading present but no article items' };
      }
      // Normal answer: the search ran and returned no articles.
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 articles for "${core}"` };
    }

    const want = norm(core);
    const records = [];
    for (const item of items) {
      const h2 = item.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const title = cleanText(h2 ? h2[1] : '');
      const hrefMatch = item.match(/<div class="article_title">\s*<a[^>]*href="([^"]+)"/i);
      const date = cleanText((item.match(/<div class="articleinfo">\s*<b>([\s\S]*?)<\/b>/i) || [])[1] || '');
      const tagsBlock = (item.match(/<div class="default articlelist_tags">([\s\S]*?)<\/div>/i) || [])[1] || '';
      const tags = [...tagsBlock.matchAll(/<a[^>]*href="tag\/[^"]*"[^>]*title="([^"]*)"/gi)].map((m) => decode(m[1]));

      const titleHit = want && norm(title).includes(want);
      const tagHit = tags.some((t) => norm(t) === want);
      if (titleHit || tagHit) {
        records.push({
          title,
          date,
          url: hrefMatch ? new URL(decode(hrefMatch[1]), BASE).href : '',
          tags,
          matched_name: core,
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${items.length} articles returned for "${core}", none names this company in its title or tags`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => `${r.date} ${r.title}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
