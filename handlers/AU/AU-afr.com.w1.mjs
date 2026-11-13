export const meta = {
  task: 'AU-afr.com',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['headline', 'url', 'published', 'summary', 'match_in'],
  canary: { found: 'Commonwealth Bank', not_found: 'Xyloquarzon Holdings Pty Ltd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TRAILING = new Set(['pty', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'plc', 'co', 'corp', 'corporation',
  'company', 'australia', 'of', 'the']);

function norm(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Company name without legal form words ("Pty Ltd", "Limited") or a trailing "of Australia". */
function coreName(keyword) {
  const tokens = norm(keyword).split(' ').filter(Boolean);
  while (tokens.length > 1 && (TRAILING.has(tokens[tokens.length - 1]) || /^\d+$/.test(tokens[tokens.length - 1]))) {
    tokens.pop();
  }
  return tokens.join(' ');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

function clean(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Story tiles on the AFR search page: headline link, summary, timestamp. */
function parseTiles(html) {
  const tiles = [];
  const blocks = html.split('data-testid="StoryTileBase"').slice(1);
  for (const block of blocks) {
    let link = null;
    for (const m of block.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)) {
      const attrs = m[1];
      if (/class="[^"]*headlineLink[^"]*"/.test(attrs)) {
        const href = attrs.match(/href="([^"]+)"/);
        if (href) { link = { href: href[1], text: clean(m[2]) }; break; }
      }
    }
    if (!link || !link.text) continue;
    const about = block.match(/<p class="[^"]*-about"[^>]*>([\s\S]*?)<\/p>/);
    const time = block.match(/<time[^>]*dateTime="([^"]*)"/);
    tiles.push({
      headline: link.text,
      url: new URL(link.href, 'https://www.afr.com').href,
      published: time ? clean(time[1]) : '',
      summary: about ? clean(about[1]) : '',
    });
  }
  return tiles;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const core = coreName(keyword || '');
  const searchUrl = `https://www.afr.com/search?text=${encodeURIComponent(core)}`;
  try {
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
               excerpt: 'no company name left after removing legal-form words' };
    }

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
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
    if (/captcha|cf-chl|challenge-platform/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
    }

    const tiles = parseTiles(html);
    const searchUi = /data-testid="(AI)?SearchInput"/.test(html);
    if (tiles.length === 0 && !searchUi) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl,
               excerpt: html.slice(0, 300) };
    }

    const needle = ` ${core} `;
    const seen = new Set();
    const records = [];
    for (const t of tiles) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      const inHeadline = ` ${norm(t.headline)} `.includes(needle);
      const inSummary = ` ${norm(t.summary)} `.includes(needle);
      if (!inHeadline && !inSummary) continue;
      records.push({
        headline: t.headline,
        url: t.url,
        published: t.published,
        summary: t.summary,
        match_in: inHeadline ? 'headline' : 'summary',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${tiles.length} results on the first page; none names "${core}" in a headline or summary`.slice(0, 300),
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} article(s) name "${core}": ${records[0].headline}`.slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
