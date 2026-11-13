export const meta = {
  task: 'SG-singaporebrides.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'snippet'],
  canary: { found: 'Frasers House, a Luxury Collection Hotel, Singapore', not_found: '新加坡虚构婚庆有限公司' },
};

const BASE = 'https://singaporebrides.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words that are dropped on both sides before comparing names.
const LEGAL = new Set(['pte', 'ltd', 'limited', 'llp', 'llc', 'sdn', 'bhd', 'berhad', 'co', 'company', 'corp',
  'corporation', 'inc', 'plc', 'pvt', 'private']);

function tokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function core(s) {
  return tokens(s).filter((t) => !LEGAL.has(t)).join('');
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '-').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = BASE + '/s/';
  try {
    const kTokens = tokens(keyword).filter((t) => !LEGAL.has(t));
    const kCore = kTokens.join('');
    const query = kTokens.join(' ');
    if (!kCore) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: url, excerpt: 'the name has no words to search' };
    }
    // One search request, built from the name: the site's own search, first page of results only.
    url = `${BASE}/s/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-SG,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();

    if (res.status === 403 || res.status === 429 || res.status === 503) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (/Just a moment|Attention Required|cf-chl|captcha/i.test(text) && !/<p class=['"]total['"]>/.test(text)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot check page' };
    }

    const totalMatch = text.match(/<p class=['"]total['"][^>]*>\s*(Search results for|No results for)[\s\S]*?<\/p>/);
    if (!totalMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: decode(text).slice(0, 300) };
    }
    if (/No results for/.test(totalMatch[0])) {
      return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: decode(totalMatch[0]) };
    }

    // Result cards: <a class="result" href="..."><h4>Name</h4><p>snippet</p></a>
    const records = [];
    const cardRe = /<a\b[^>]*\bclass="result"[^>]*>\s*<h4[^>]*>([\s\S]*?)<\/h4>/g;
    let m;
    while ((m = cardRe.exec(text)) !== null) {
      const hrefMatch = m[0].match(/\shref="([^"]+)"/);
      if (!hrefMatch) continue;
      const name = decode(m[1]);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2000).split('</a>')[0];
      const pMatch = after.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const snippet = pMatch ? decode(pMatch[1]).slice(0, 300) : '';
      // Same company: the whole listed name, or the part before the first comma ("Frasers House, a Luxury ... Singapore").
      if (core(name) === kCore || core(name.split(',')[0]) === kCore) {
        records.push({ name, profile_url: new URL(decode(hrefMatch[1]), BASE).href, snippet });
      }
    }

    if (records.length) {
      const r = records[0];
      return { status: 'found', reason: '', records, source_url: url, excerpt: `${r.name}: ${r.snippet}`.slice(0, 500) };
    }

    // No match on page 1. If the site has more pages, the company may be on one we did not read: say so, do not call it absent.
    if (/[?&;]start=10(?!\d)/.test(text)) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: url,
        excerpt: `no match on the first page of results for "${query}"; more pages exist and were not read`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: `No listing matching "${keyword}" in the results for "${query}"`,
    };
  } catch (err) {
    const name = err && err.name;
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
