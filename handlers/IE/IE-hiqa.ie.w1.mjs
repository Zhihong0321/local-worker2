export const meta = {
  task: 'IE-hiqa.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'centre_id', 'centre_type', 'county', 'address', 'phone', 'max_occupancy', 'url'],
  canary: { found: 'Tallaght University Hospital', not_found: 'Cuideachta Dezeno Teoranta' },
};

const BASE = 'https://www.hiqa.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;          // 12 results per page; stop after this many pages
const PAGE_BUDGET_MS = 35000; // do not start another results page after this much time
const LEGAL = new Set(['ltd', 'limited', 'teoranta', 'dac', 'clg', 'uc', 'unlimited', 'plc', 'llc', 'inc',
  'sdn', 'bhd', 'pte', 'gmbh', 'sa', 'srl', 'bv', 'ag', 'company']);

/** Decode the HTML entities that appear in HIQA's markup. */
function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0*39;|&#x0*27;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&#0*8211;/gi, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparable form of a company name: case, accents, punctuation and trailing legal form removed. */
function core(name) {
  const words = decode(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Search words sent to the site: the legal form is dropped so it does not block the match. */
function searchWords(name) {
  const words = decode(name).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1].replace(/[^A-Za-z]/g, '').toLowerCase())) words.pop();
  return words.join(' ');
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IE,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Read the detail page of one centre: the labelled fields in its "centre information" block. */
async function readDetail(href) {
  const url = new URL(href, BASE).href;
  try {
    const res = await get(url);
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    const html = await res.text();
    const out = { url };
    const re = /views-label-field-([a-z0-9-]+)">[^<]*<\/span>\s*<div class="field-content">([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
      const key = m[1];
      const value = decode(m[2]);
      if (key === 'centre-id') out.centre_id = value;
      else if (key === 'centre-type-1') out.centre_type = value;
      else if (key === 'county') out.county = value;
      else if (key === 'centre-address') out.address = value;
      else if (key === 'centre-phone') out.phone = value;
      else if (key === 'centre-max-occupancy') out.max_occupancy = value;
    }
    return out;
  } catch (err) {
    return { url, error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const startUrl = `${BASE}/find-a-centre?keywords=${encodeURIComponent(searchWords(keyword)) || encodeURIComponent(keyword)}`;
  const startedAt = Date.now();
  try {
    // 1. Read the search result pages (12 centres per page) until there is no next page.
    const wanted = core(keyword);
    if (!wanted) return fail('other', startUrl, 'the keyword has no usable name');

    let pageUrl = startUrl;
    let pages = 0;
    let morePages = false;
    const hits = [];
    let totalSeen = 0;

    while (true) {
      const res = await get(pageUrl);
      if (res.status === 403 || res.status === 429) return fail('blocked', pageUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', pageUrl, `HTTP ${res.status}`);

      const html = await res.text();
      pages++;
      const hasContainer = html.includes('view-find-a-centre') && html.includes('Find a Centre');
      if (!hasContainer) {
        if (/captcha|Just a moment|Attention Required|cf-chl|Access denied|Checking your browser/i.test(html)) {
          return fail('blocked', pageUrl, 'bot check or challenge page');
        }
        return fail('layout_changed', pageUrl, html.slice(0, 300));
      }

      const entries = html.match(/<li class="entry[\s\S]*?<\/li>/g) || [];
      for (const entry of entries) {
        const link = entry.match(/<h3><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/);
        if (!link) continue;
        totalSeen++;
        const name = decode(link[2]);
        if (core(name) === wanted) hits.push({ href: link[1], name, listId: (entry.match(/ID:\s*(\d+)/) || [])[1] || '' });
      }

      const next = html.match(/<li class="pager__item pager__item--next"[^>]*>\s*<a href="([^"]+)"/);
      if (!next) break;
      if (pages >= MAX_PAGES || Date.now() - startedAt > PAGE_BUDGET_MS) { morePages = true; break; }
      pageUrl = new URL(next[1].replace(/&amp;/g, '&'), pageUrl).href;
    }

    // 2. Nothing matched on every page that was read.
    if (hits.length === 0) {
      if (morePages) {
        return fail('other', startUrl, `search has more pages than were read (${pages} read, ${totalSeen} centres seen, no exact name match yet)`);
      }
      if (totalSeen === 0) {
        return { status: 'not_found', reason: '', records: [], source_url: startUrl, excerpt: `No centre on the HIQA register matches "${keyword}" (0 results)` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: startUrl, excerpt: `${totalSeen} centres returned for "${keyword}", none with this name` };
    }

    // 3. Read the detail page of each exact match (in parallel) and build the records.
    const details = await Promise.all(hits.map((h) => readDetail(h.href)));
    const records = hits.map((h, i) => {
      const d = details[i];
      const rec = {
        name: h.name,
        centre_id: d.centre_id || h.listId || '',
        centre_type: d.centre_type || '',
        county: d.county || '',
        address: d.address || '',
        phone: d.phone || '',
        max_occupancy: d.max_occupancy || '',
        url: d.url,
      };
      if (d.error) rec.detail_error = d.error;
      return rec;
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: startUrl,
      excerpt: records.map((r) => `${r.name} | ID ${r.centre_id} | ${r.county}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', startUrl, String(err?.message || err));
  }
}
