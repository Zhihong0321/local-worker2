export const meta = { task: 'MY-freemalaysiatoday.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['title', 'date', 'url', 'category', 'excerpt'],
  canary: { found: 'Petronas Chemicals', not_found: 'Syarikat Dezeno Sdn Bhd' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SITE = 'https://www.freemalaysiatoday.com';

// Legal-form words at the end of a name are dropped before searching and matching ("ACME TRADING SDN BHD" -> "ACME TRADING").
function coreName(str) {
  let s = (str || '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const legal = /\s+(sdn\s+bhd|berhad|bhd|sdn|plt|llp|pte\s+ltd|ltd)$/i;
  let prev;
  do { prev = s; s = s.replace(legal, '').trim(); } while (s !== prev);
  return s;
}

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;/gi, "'").replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const core = coreName(keyword);
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty company name' };
    }
    searchUrl = `${SITE}/api/search?term=${encodeURIComponent(core)}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': `${SITE}/search/?term=${encodeURIComponent(core)}` },
      signal: AbortSignal.timeout(25000),
    });

    const body = await res.text();
    if (res.status === 403 || res.status === 429 || /challenge-platform|cf-chl|captcha/i.test(body.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    if (!json || !json.posts || !Array.isArray(json.posts.edges)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: body.slice(0, 300) };
    }

    const edges = json.posts.edges;
    if (edges.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 articles match "${core}"` };
    }

    // Keep only articles whose headline or excerpt really carries the company name (whole words, normalised).
    const want = ` ${normalize(core)} `;
    const records = [];
    for (const edge of edges) {
      const n = edge && edge.node;
      if (!n || !n.title || !n.uri) continue;
      const title = cleanText(n.title);
      const excerpt = cleanText(n.excerpt).slice(0, 300);
      const hit = ` ${normalize(title)} `.includes(want) || ` ${normalize(excerpt)} `.includes(want);
      if (!hit) continue;
      const cat = n.categories && n.categories.edges && n.categories.edges[0] && n.categories.edges[0].node;
      records.push({
        title,
        date: n.date ? String(n.date).slice(0, 10) : '',
        url: new URL(n.uri, SITE).href,
        category: cat && cat.name ? cat.name : '',
        excerpt,
      });
    }

    if (records.length === 0) {
      // The site matched the name somewhere in the article body only; the handler cannot confirm that without opening each article.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: `${edges.length} articles returned for "${core}" but none has the name in its headline or excerpt` };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} FMT article(s) carry "${core}" in the headline or excerpt (first page of results): ${records[0].title}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: searchUrl || SITE,
      excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
