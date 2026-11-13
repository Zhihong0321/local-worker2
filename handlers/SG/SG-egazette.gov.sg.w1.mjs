export const meta = {
  task: 'SG-egazette.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_no', 'notice_title', 'category', 'sub_category', 'notification_no', 'publish_date', 'file_url', 'excerpt'],
  canary: { found: 'UMMU FAZWILL SG PTE. LTD.', not_found: 'Syarikat Khayalan Tiada Wujud Sdn Bhd' },
};

const SITE = 'https://www.egazette.gov.sg';
const SEARCH_PAGE = `${SITE}/egazette-browse/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HITS_PER_PAGE = 50;
const MAX_PAGES = 4;
const DEADLINE_MS = 40000;

// Legal-form words that can end a company name (compared on normalised words, so "PTE. LTD." -> pte, ltd).
const LEGAL = ['pte', 'ltd', 'limited', 'sdn', 'bhd', 'berhad', 'llp', 'llc', 'inc', 'incorporated', 'plc', 'corp',
  'corporation', 'pvt', 'private', 'co', 'lp', 'vcc'];
// Words that may follow a company name in a notice ("ACME PTE LTD has been ...", "... ACME PTE LTD of ...").
// Any other word after the name means a different company (e.g. "ACME TRADING" is not "ACME").
const STOP = ['of', 'has', 'have', 'in', 'is', 'was', 'are', 'at', 'on', 'to', 'with', 'whose', 'the', 'as', 'by', 'for',
  'from', 'under', 'dated', 'being', 'which', 'that', 'reg', 'registration', 'uen', 'no', 'number', 'will', 'be'];
const SEP = '[^\\p{L}\\p{N}]+';
const LEGAL_ALT = LEGAL.join('|');

function words(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/** The name's own words, without the trailing legal form: "ACME TRADING PTE. LTD." -> [acme, trading]. */
function coreWords(keyword) {
  const w = words(keyword);
  while (w.length && LEGAL.includes(w[w.length - 1])) w.pop();
  return w;
}

/** Every place in the raw notice text where the whole name appears as its own name (not as part of a longer name). */
function findNames(text, core) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${core.join(SEP)}`, 'giu');
  const out = [];
  for (const m of text.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    if (/[\p{L}\p{N}]/u.test(text.charAt(end))) continue;
    const after = text.slice(end, end + 120);
    const next = (after.match(/^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u) || [])[1];
    const nextWord = next ? next.toLowerCase() : '';
    if (nextWord && !LEGAL.includes(nextWord) && !STOP.includes(nextWord)) continue;
    const tail = after.match(new RegExp(`^(?:${SEP}(?:${LEGAL_ALT})(?![\\p{L}\\p{N}]))*\\.?`, 'iu'))[0];
    const nameEnd = end + tail.length;
    out.push({ start, nameEnd, name: text.slice(start, nameEnd).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

function recordFor(hit, text, found) {
  const before = text.slice(Math.max(0, found.start - 100), found.start);
  const regs = before.match(/(?<![A-Za-z0-9])(?:\d{8,9}[A-Z]|T\d{2}[A-Z]{2}\d{4}[A-Z])(?![A-Za-z0-9])/g);
  const excerpt = text.slice(Math.max(0, found.start - 120), Math.min(text.length, found.nameEnd + 120))
    .replace(/\s+/g, ' ').trim();
  return {
    name: found.name,
    registration_no: regs ? regs[regs.length - 1] : '',
    notice_title: hit.title || '',
    category: hit.category || '',
    sub_category: hit.subCategory || '',
    notification_no: hit.notificationNum || '',
    publish_date: hit.publishDate || '',
    file_url: hit.fileUrl || '',
    excerpt,
  };
}

const blocked = (url, excerpt) => ({ status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt });
const httpError = (url, status) => ({ status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${status}` });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const pageUrl = `${SEARCH_PAGE}?q=${encodeURIComponent(String(keyword ?? ''))}`;
  try {
    const core = coreWords(keyword);
    if (!core.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'no name words to search for' };
    }

    // 1. The search page carries the public search settings the page itself uses (search-only key, index name).
    const pageRes = await fetch(SEARCH_PAGE, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) return blocked(pageUrl, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return httpError(pageUrl, pageRes.status);
    const html = await pageRes.text();
    if (/captcha|cf-chl|challenge-platform/i.test(html)) return blocked(pageUrl, 'bot check page');
    const appId = html.match(/appId\W{1,8}([A-Za-z0-9]{10})\W/)?.[1];
    const apiKey = html.match(/searchApiKey\W{1,8}([a-f0-9]{32})\W/)?.[1];
    const indexName = html.match(/indexName\W{1,8}([A-Za-z0-9_]+)\W/)?.[1];
    if (!appId || !apiKey || !indexName) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: 'search settings not found on the page' };
    }

    // 2. Ask the same index the page searches, up to MAX_PAGES pages of notices.
    const endpoint = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
    const hits = [];
    let nbHits = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Quoted = the index must contain the name's words as one phrase; without quotes a common word like "ACME" floods the list.
      const query = new URLSearchParams({ query: `"${core.join(' ')}"`, hitsPerPage: String(HITS_PER_PAGE), page: String(page) });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-algolia-application-id': appId,
          'x-algolia-api-key': apiKey,
        },
        body: JSON.stringify({ params: query.toString() }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return blocked(pageUrl, `search HTTP ${res.status}`);
      if (!res.ok) return httpError(pageUrl, res.status);
      const body = await res.json();
      if (!Array.isArray(body.hits)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: 'search answer has no hits list' };
      }
      hits.push(...body.hits);
      nbHits = Number(body.nbHits) || hits.length;
      const nbPages = Number(body.nbPages) || 1;
      if (page + 1 >= nbPages) break;
      if (Date.now() - started > DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: pageUrl, excerpt: 'search ran out of time' };
      }
    }

    // 3. Keep only notices where this company's own name appears.
    const records = [];
    const seen = new Set();
    for (const hit of hits) {
      const text = String(hit.text || '');
      for (const found of findNames(text, core)) {
        const rec = recordFor(hit, text, found);
        const key = `${rec.file_url}|${rec.name.toUpperCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(rec);
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: pageUrl, excerpt: records[0].excerpt.slice(0, 400) };
    }
    if (nbHits > hits.length) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl,
        excerpt: `${nbHits} notices match these words; only the first ${hits.length} were checked`,
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: pageUrl,
      excerpt: hits.length
        ? `${hits.length} notice(s) matched the words, none names this company`
        : '0 notices matched',
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: pageUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
