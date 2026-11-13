export const meta = {
  task: 'TH-halal.or.th',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'certificate_no', 'certificate_type', 'date_of_issue', 'destination', 'detail_url'],
  canary: { found: 'CPF (THAILAND) PUBLIC COMPANY LIMITED', not_found: 'ZZZNOTEXIST123 CO., LTD.' },
};

const BASE = 'https://www.halal.or.th';
const SEARCH = BASE + '/th/cert_hl2/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CERT_TYPE = 'Export/Shipment Halal Certificates (HL.2)';
const TIME_LIMIT_MS = 30000; // no new page is started after 30 s, so the call ends under 60 s
const MAX_RECORDS = 200;

// Legal-form words dropped before comparing names.
const LEGAL = new Set(['co', 'company', 'ltd', 'limited', 'public', 'pcl', 'plc', 'sdn', 'bhd', 'pte', 'inc', 'corp', 'corporation', 'llc']);
// Words too common to search on by themselves.
const GENERIC = new Set([...LEGAL, 'thai', 'thailand', 'the', 'and', 'of', 'group', 'international']);

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return decode(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
}

/** Comparison key: letters and digits only, lower case, legal form removed. */
function matchKey(s) {
  return tokens(s).filter((t) => !LEGAL.has(t)).join(' ');
}

function pageUrl(query, page) {
  return (page === 1 ? SEARCH : `${SEARCH}/${page}`) + `?keyword=${encodeURIComponent(query)}`;
}

/** Parse the certificate cards of one results page. */
function parseCards(html) {
  const cards = [];
  for (const part of html.split('class="cert-card"').slice(1)) {
    const company = part.match(/<span class="cert-company">([\s\S]*?)<\/span>/);
    if (!company) continue;
    const title = part.match(/<h3 class="cert-title">([\s\S]*?)<\/h3>/);
    const date = part.match(/title="วันที่ออก"[^>]*>([\s\S]*?)<\/span>/);
    const dest = part.match(/title="ปลายทาง"[^>]*>([\s\S]*?)<\/span>/);
    const href = part.match(/href="([^"]*\/cert_hl2\/detail\/\d+)"/);
    cards.push({
      name: clean(company[1]),
      certificate_no: clean(title && title[1]),
      certificate_type: CERT_TYPE,
      date_of_issue: clean(date && date[1]),
      destination: clean(dest && dest[1]),
      detail_url: href ? new URL(href[1], BASE).href : '',
    });
  }
  return cards;
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const input = String(keyword || '').trim();
  const key = matchKey(input);
  if (!key) return fail('other', SEARCH, 'empty company name');

  // The site lists exporters in English only, and its search returns results for any Thai text,
  // so a Thai name cannot be matched or ruled out.
  if (/[฀-๿]/.test(input)) {
    return fail('other', SEARCH, 'Name is written in Thai. The site shows English names only and its search answers any Thai text with results, so a match cannot be confirmed.');
  }

  try {
    const words = key.split(' ');
    const query = (words.find((w) => !GENERIC.has(w)) || words[0]).toUpperCase();
    const firstUrl = pageUrl(query, 1);

    const matches = [];
    const seen = new Set();
    let page = 1;
    let totalPages = 1;
    let scanned = 0;
    let complete = false;

    while (true) {
      if (page > 1 && Date.now() - t0 > TIME_LIMIT_MS) break;

      const res = await fetch(pageUrl(query, page), {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'th,en;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', firstUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', firstUrl, `HTTP ${res.status}`);

      const html = await res.text();
      if (page === 1 && !html.includes('results-count')) return fail('layout_changed', firstUrl, html.slice(0, 200));

      const cards = parseCards(html);
      if (page === 1 && cards.length === 0) {
        if (html.includes('cert-empty-state')) {
          return { status: 'not_found', reason: '', records: [], source_url: firstUrl, excerpt: `The site search for "${query}" returned no certificates.` };
        }
        return fail('layout_changed', firstUrl, 'results page without cards or an empty-state message');
      }

      for (const c of cards) {
        scanned++;
        if (matchKey(c.name) === key) {
          const id = `${c.certificate_no}|${c.name}`;
          if (!seen.has(id)) { seen.add(id); matches.push(c); }
        }
      }

      const pageNums = [...html.matchAll(/data-ci-pagination-page="(\d+)"/g)].map((m) => Number(m[1]));
      totalPages = Math.max(totalPages, ...pageNums);
      if (page >= totalPages || cards.length === 0) { complete = true; break; }
      page++;
    }

    if (matches.length) {
      const first = matches[0];
      const partial = complete ? '' : ' (time limit reached before the last page)';
      return {
        status: 'found',
        reason: '',
        records: matches.slice(0, MAX_RECORDS),
        source_url: firstUrl,
        excerpt: `${matches.length} certificate(s) for "${first.name}"; scanned ${page} of ${totalPages} result pages${partial}. First: ${first.certificate_no}, issued ${first.date_of_issue}.`,
      };
    }

    if (complete) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `The site search for "${query}" gave ${scanned} results over ${totalPages} page(s); none is named "${input}".`,
      };
    }
    return fail('timeout', firstUrl, `scanned ${page} of ${totalPages} result pages in 30 s; no match yet`);
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, SEARCH, String(err?.message || err));
  }
}
