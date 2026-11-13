export const meta = { task: 'MY-bmcc.org.my', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'sector', 'website', 'url', 'post_id'],
  canary: { found: 'ADP Malaysia Sdn Bhd', not_found: 'Syarikat Tiada Wujud Sdn Bhd' } };

const SITE = 'https://bmcc.org.my';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'pte', 'ltd', 'limited', 'llp', 'llc', 'inc', 'plt', 'enterprise']);

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Normalised company name: lower case, punctuation and legal form removed ("ADP Malaysia Sdn Bhd" -> "adpmalaysia"). */
function norm(s) {
  const text = decode(s).toLowerCase().replace(/\(\s*m\s*\)/g, ' ');
  const tokens = text.match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.filter((t) => !LEGAL.has(t)).join('');
}

function headers(accept) {
  return { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' };
}

function failure(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function reasonFromError(err) {
  const name = String(err?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'other';
}

/** Detail page of one company post: sector and website (both optional; a missing one is not an error). */
async function readDetail(url) {
  try {
    const res = await fetch(url, { headers: headers('text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'), signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { sector: '', website: '' };
    const html = await res.text();
    const sector = (html.match(/<p>\s*<span style="color: #2178a5;">([^<]+)<\/span>\s*<\/p>\s*<h3 class="mt-0">/i) || [])[1] || '';
    const site = (html.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>\s*Visit Website\s*<\/a>/i) || [])[1] || '';
    return { sector: decode(sector), website: site };
  } catch {
    return { sector: '', website: '' };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node 24 on Windows aborts ("UV_HANDLE_CLOSING") when the runner calls process.exit right after a fetch,
  // so give the keep-alive sockets half a second to close before the answer is handed back.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  const searchUrl = `${SITE}/wp-json/wp/v2/search?search=${encodeURIComponent(keyword)}&per_page=100`;
  try {
    const wanted = norm(keyword);
    if (!wanted) return failure('other', searchUrl, 'the name has no letters or digits');

    const res = await fetch(searchUrl, { headers: headers('application/json'), signal: AbortSignal.timeout(25000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return failure('blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) return failure('http_error', searchUrl, `HTTP ${res.status}`);

    const body = await res.text();
    let items;
    try {
      items = JSON.parse(body);
    } catch {
      const looksBlocked = /captcha|challenge|access denied|forbidden/i.test(body.slice(0, 2000));
      return failure(looksBlocked ? 'blocked' : 'layout_changed', searchUrl, body.slice(0, 300));
    }
    if (!Array.isArray(items)) return failure('layout_changed', searchUrl, body.slice(0, 300));
    if (items.length && !items.some((i) => i && typeof i.title === 'string' && typeof i.url === 'string')) {
      return failure('layout_changed', searchUrl, body.slice(0, 300));
    }

    // Keep only exact matches on the normalised name: a company is found, similar words are not.
    const matches = items.filter((i) => i && typeof i.title === 'string' && norm(i.title) === wanted && typeof i.url === 'string');
    if (!matches.length) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 BMCC site entries match "${keyword}" (${items.length} search hits)` };
    }

    const records = [];
    for (const m of matches.slice(0, 3)) {
      const detail = await readDetail(m.url);
      records.push({ name: decode(m.title), sector: detail.sector, website: detail.website, url: m.url, post_id: m.id ?? null });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].url,
      excerpt: `BMCC membership directory entry: ${records[0].name}${records[0].sector ? ' | ' + records[0].sector : ''}`.slice(0, 500),
    };
  } catch (err) {
    return failure(reasonFromError(err), searchUrl, String(err?.message || err));
  }
}
