export const meta = { task: 'ID-kaskus.co.id', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'thread_id', 'url', 'community', 'posted_at', 'replies', 'views'],
  canary: { found: 'PT Telkom Indonesia', not_found: 'PT Zqxvrw Nusantara Lestari' } };

// Kaskus has no company register. Its public thread search (the same JSON API the site's own search page calls)
// returns forum threads. A company counts as found only when a thread TITLE names it (legal form ignored).
const API = 'https://www.kaskus.co.id/api/search/threads';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['pt', 'cv', 'tbk', 'persero', 'ud', 'perum']);

/** Lower-case, letters and digits only, legal-form words removed: "PT. Telkom Indonesia Tbk" -> "telkom indonesia". */
function coreName(str) {
  return (str || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w)).join(' ');
}

function failure(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = API;
  try {
    const core = coreName(keyword);
    if (!core) return failure('other', API, 'no company name in the input');
    searchUrl = `${API}?searchterm=${encodeURIComponent(core)}&limit=20`;

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return failure('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', searchUrl, `HTTP ${res.status}`);

    const body = await res.text();
    let json;
    try { json = JSON.parse(body); } catch {
      if (/captcha|verify you are|access denied/i.test(body)) return failure('blocked', searchUrl, body.slice(0, 200));
      return failure('layout_changed', searchUrl, body.slice(0, 200));
    }
    if (!json || !Array.isArray(json.data)) return failure('layout_changed', searchUrl, JSON.stringify(json).slice(0, 200));

    const threads = json.data.filter((t) => t && typeof t.title === 'string');
    if (json.data.length > 0 && threads.length === 0) return failure('layout_changed', searchUrl, 'thread items have no title');

    const needle = ` ${core} `;
    const records = [];
    for (const t of threads) {
      const hay = ` ${coreName(t.title)} `;
      if (!hay.includes(needle)) continue;
      records.push({
        name: t.title,
        thread_id: t.id || '',
        url: t.id && t.slug ? `https://www.kaskus.co.id/thread/${t.id}/${t.slug}` : '',
        community: (t.community && t.community.name) || '',
        posted_at: t.dateline ? new Date(Number(t.dateline) * 1000).toISOString() : '',
        replies: t.meta ? t.meta.total_replies ?? null : null,
        views: t.meta ? t.meta.total_views ?? null : null,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${json.data.length} thread(s) returned for "${core}", none titled with this company name`,
      };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} thread(s) titled with "${core}": ${records.map((r) => r.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(timedOut ? 'timeout' : 'other', searchUrl, String(err && err.message ? err.message : err));
  }
}
