export const meta = {
  task: 'TW-businesstoday.com.tw',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'title', 'date', 'url', 'summary'],
  canary: { found: '台積電', not_found: '虛構測試科技股份有限公司' },
};

const BASE = 'https://www.businesstoday.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that the site's tag names normally leave out (Taiwan and common English forms).
const LEGAL_SUFFIXES = [
  /股份有限公司$/, /有限公司$/, /股份有限$/, /有限$/, /公司$/,
  /pte\.?\s*ltd\.?$/i, /sdn\.?\s*bhd\.?$/i, /co\.?\s*,?\s*ltd\.?$/i, /ltd\.?$/i, /limited$/i,
  /incorporated$/i, /inc\.?$/i, /corporation$/i, /corp\.?$/i,
];

function cleanName(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function stripLegalForm(s) {
  let out = cleanName(s);
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEGAL_SUFFIXES) {
      const next = out.replace(re, '').replace(/[\s,.]+$/, '');
      if (next && next !== out) { out = next; changed = true; }
    }
  }
  return out;
}

function decodeText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function getPage(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9',
      // Close the socket after each reply, so no keep-alive handle is left open when the runner exits.
      'Connection': 'close',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the closed sockets finish before the runner calls process.exit (Windows Node aborts otherwise).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  let lastUrl = `${BASE}/tag`;
  try {
    const full = cleanName(keyword);
    const short = stripLegalForm(keyword);
    const candidates = [...new Set([full, short])].filter(Boolean);
    if (candidates.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl, excerpt: 'empty company name' };
    }

    const tried = [];
    for (const name of candidates) {
      const url = `${BASE}/tag?name=${encodeURIComponent(name)}`;
      lastUrl = url;
      tried.push(name);

      const res = await getPage(url);
      if (res.status === 202 || res.status === 403 || res.status === 429 || res.headers.get('x-amzn-waf-action')) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const raw = await res.text();
      if (/token\.awswaf\.com|awsWafCookieDomainList/.test(raw) && !raw.includes('searchitem')) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
      }

      // Drop HTML comments: the site keeps commented-out copies of every link.
      const html = raw.replace(/<!--[\s\S]*?-->/g, '');

      // The site's own "no results" answer for this tag.
      if (html.includes('找不到相關結果')) continue;

      if (!html.includes('searchitem__title')) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: decodeText(html).slice(0, 300) };
      }

      // The page must be the tag we asked for, not a redirect to a different tag.
      const canon = html.match(/rel="canonical"\s+href="[^"]*\/tag\?name=([^"]+)"/i);
      if (canon && cleanName(safeDecode(canon[1])) !== name) continue;

      const chunks = html.split('class="searchitem__item"').slice(1);
      const records = [];
      for (const chunk of chunks) {
        const t = chunk.match(/<a href="([^"]+)" class="searchitem__title-link"[^>]*>([\s\S]*?)<\/a>/i);
        if (!t) continue;
        const d = chunk.match(/searchitem__date">\s*日期：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
        const s = chunk.match(/<p class="searchitem__text">([\s\S]*?)<\/p>/i);
        records.push({
          name,
          title: decodeText(t[2]),
          date: d ? d[1] : '',
          url: new URL(t[1].replace(/&amp;/g, '&'), BASE).href,
          summary: s ? decodeText(s[1]).slice(0, 300) : '',
        });
      }

      if (records.length === 0) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'tag page has no article entries' };
      }

      return {
        status: 'found',
        reason: '',
        records,
        source_url: url,
        excerpt: records.slice(0, 5).map((r) => `${r.date} ${r.title}`).join(' | ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${BASE}/tag?name=${encodeURIComponent(full)}`,
      excerpt: `site search for tag ${tried.map((n) => `"${n}"`).join(', ')}: 找不到相關結果`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
