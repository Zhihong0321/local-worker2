export const meta = {
  task: 'TW-fsc.gov.tw',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'detail_url'],
  canary: { found: 'Taiwan Cooperative Bank', not_found: 'Zyxwv Holdings Ltd' },
};

// Keyword search on the FSC Banking Bureau "Major Enforcement Actions" list (linked from fsc.gov.tw > Enforcement).
// Searching is a POST to the same list page that the site's own search form uses. Titles are in English.
const BASE = 'https://www.banking.gov.tw/en/home.jsp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = /\b(co|ltd|limited|inc|corp|corporation|company|llc|plc|sdn|bhd|pte|the)\b/g;
const MAX_PAGES = 5;
const DEADLINE_MS = 40000;

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return (s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;|&#x20;|&#32;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = `${BASE}?id=93&parentpath=0,86`;
  const started = Date.now();
  try {
    const shown = String(keyword || '').trim();
    if (!shown) return couldnt('other', sourceUrl, 'empty keyword');
    // The list has English titles only. A Chinese-only name cannot be matched here, so it is not called not_found.
    if (/[㐀-鿿]/.test(shown)) {
      return couldnt('other', sourceUrl, 'English-only list: a name written in Chinese characters cannot be matched here (not the same as not listed)');
    }
    const name = normalize(shown).replace(/ /g, '');
    if (name.length < 3) return couldnt('other', sourceUrl, 'name too short to match safely');

    const records = [];
    let total = 1;
    let done = 0;
    let complete = true;
    for (let page = 1; page <= total; page++) {
      if (page > MAX_PAGES || Date.now() - started > DEADLINE_MS) { complete = false; break; }
      const body = new URLSearchParams({
        id: '93', contentid: '93', parentpath: '0,86', mcustomize: 'onemessage_list.jsp',
        keyword: shown, page: String(page), pagesize: '10', qptdate: '', qdldate: '', dateid: '',
      });
      const res = await fetch(BASE, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': sourceUrl,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', sourceUrl, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', sourceUrl, `HTTP ${res.status}`);
      const html = await res.text();
      const hasRows = /class="ptitle1"/.test(html);
      const noData = /No Data/i.test(html);
      if (!hasRows && !noData) return couldnt('layout_changed', sourceUrl, html.slice(0, 300));
      if (noData && !hasRows) { done++; break; }

      const span = html.match(/<span class="page">\s*(\d+)\s*\/\s*(\d+)/);
      if (span) total = Number(span[2]);

      const re = /<div class="ptitle1">\s*<a href="([^"]*dataserno=[^"]*)" title="([^"]*)"[\s\S]*?<\/div>\s*<div class="pdate1">([^<]*)<\/div>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const title = decode(m[2]);
        if (normalize(title).replace(/ /g, '').includes(name)) {
          records.push({ title, date: decode(m[3]), detail_url: new URL(decode(m[1]), BASE).href });
        }
      }
      done++;
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: sourceUrl, excerpt: `${records.length} matching announcement(s) on the Banking Bureau list` };
    }
    if (!complete || done === 0) return couldnt('timeout', sourceUrl, 'results not read to the end before the time limit');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `No match for "${shown}" on the FSC Banking Bureau major enforcement list (English titles, banking entities). Securities and insurance lists are not checked here.`,
    };
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return couldnt('timeout', sourceUrl, String(err?.message || err));
    return couldnt('other', sourceUrl, String(err?.message || err));
  }
}
