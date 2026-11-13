export const meta = {
  task: 'CH-startupticker.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['headline', 'date', 'category', 'url'],
  canary: { found: 'xorlab', not_found: 'Zzqxwvkrt Gesellschaft' },
};

const BASE = 'https://www.startupticker.ch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words at the end of a name. Articles write the brand name, so these are removed before the site search.
const LEGAL_FORM_END = /(?:,\s*|\s+)(?:ag|sa|gmbh|sàrl|sarl|sagl|kg|ltd|limited|inc|llc|llp|plc|se|sas|bv|nv|oy|ab|aps|srl|spa|pte|co|corp|corporation|company)\.?$/i;

function brandName(keyword) {
  const original = String(keyword || '').replace(/\s+/g, ' ').trim();
  let s = original;
  let prev;
  do {
    prev = s;
    s = s.replace(LEGAL_FORM_END, '').replace(/[.,;:\s]+$/, '').trim();
  } while (s !== prev && s);
  return s || original;
}

function decode(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : ''))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function out(status, reason, sourceUrl, excerpt, records = []) {
  return { status, reason, records, source_url: sourceUrl, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = brandName(keyword);
  const sourceUrl = `${BASE}/en/search?q=${encodeURIComponent(name)}&match=exact-phrase`;
  if (!name) return out('couldnt_check', 'other', sourceUrl, 'empty company name');

  try {
    const res = await fetch(sourceUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,de;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return out('couldnt_check', 'blocked', sourceUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return out('couldnt_check', 'http_error', sourceUrl, `HTTP ${res.status}`);
    }

    const html = await res.text();

    // The site's own empty-result message.
    if (html.includes('no records were found matching')) {
      return out('not_found', '', sourceUrl, 'Unfortunately, no records were found matching the given criteria!');
    }

    // Each hit on the results page is one <div class="list-content"> block: date, headline link, category.
    const blocks = html.split('<div class="list-content">').slice(1);
    const seen = new Set();
    const records = [];
    for (const block of blocks) {
      const chunk = block.slice(0, 3000);
      const link = chunk.match(/<a href="(\/en\/news\/[^"]+)">\s*<h2>([\s\S]*?)<\/h2>/);
      if (!link) continue;
      const url = new URL(link[1], BASE).href;
      if (seen.has(url)) continue;
      seen.add(url);
      const date = chunk.match(/<div class="date">\s*([^<]+?)\s*<\/div>/);
      const category = chunk.match(/category=[^"]*">\s*<li[^>]*><\/li>\s*([^<]+?)\s*<\/a>/);
      records.push({
        headline: decode(link[2]),
        date: date ? decode(date[1]) : '',
        category: category ? decode(category[1]) : '',
        url,
      });
    }

    if (records.length > 0) {
      return out(
        'found',
        '',
        sourceUrl,
        `${records.length} article(s) on the first results page contain "${name}"; first: ${records[0].date} ${records[0].headline}`,
        records,
      );
    }

    // No hits and no empty-result message: the page is not what we expect.
    return out('couldnt_check', 'layout_changed', sourceUrl, html.slice(0, 300));
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', sourceUrl, String(err?.message || err).slice(0, 300));
  }
}
