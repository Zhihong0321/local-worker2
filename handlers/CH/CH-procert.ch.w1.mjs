export const meta = { task: 'CH-procert.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'customer_no', 'address', 'website', 'certifications_url'],
  canary: { found: 'Catering Services Migros', not_found: 'Zwergenhaus Gartenbau Glarnisch GmbH' } };

// ProCert "Zertifikate" page: customer search is a plain GET form (field custname), results are server-rendered,
// 20-ish per page, paged with page=N. Search is a substring match on the customer name and is accent-sensitive.

const SEARCH_URL = 'https://www.procert.ch/de/zertifikate-11.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 30;
const NO_NEW_PAGE_AFTER_MS = 30000; // each fetch may take 25 s, so a new page must start before 30 s

const LEGAL_FORMS = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'plc', 'kg', 'ug']);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Drops trailing legal-form words (AG, SA, GmbH, Sàrl ...) and stray punctuation tokens. */
function stripLegal(s) {
  const tokens = String(s || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1) {
    const last = fold(tokens[tokens.length - 1]).replace(/[^a-z0-9]/g, '');
    if (last === '' || LEGAL_FORMS.has(last)) tokens.pop();
    else break;
  }
  return tokens.join(' ');
}

/** Comparison key: no legal form, no accents, no case, no punctuation. */
function key(s) {
  return fold(stripLegal(s)).replace(/[^a-z0-9]/g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function clean(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/(,\s*)+,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '').trim();
}

function searchUrl(term, page) {
  const u = new URL(SEARCH_URL);
  const params = { standardno: '', productgroupno: '', productname: '', custname: term, custno: '',
    zipcodecity: '', countrycode: '', send: 'Filtern' };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function parseSections(html) {
  const out = [];
  const re = /<section class="cert-customer" id="itemid-(\d+)">([\s\S]*?)<\/section>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[2];
    const nameM = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const noM = body.match(/fa-hashtag[\s\S]*?<\/i>\s*([0-9]+)/i);
    const addrM = body.match(/<div class="ym-gbox cert-txt">\s*<p>([\s\S]*?)<\/p>/i);
    const webM = body.match(/<a href="([^"]+)" target="_blank"><i class="fa fa-external-link"/i);
    const certM = body.match(/<a href="([^"]*\/zertifikate\/[^"]*)"/i);
    out.push({
      name: nameM ? clean(nameM[1]) : '',
      customer_no: noM ? noM[1] : m[1],
      address: addrM ? clean(addrM[1].replace(/<a [\s\S]*?<\/a>/gi, '')) : '',
      website: webM ? new URL(decode(webM[1]), SEARCH_URL).href : '',
      certifications_url: certM ? new URL(decode(certM[1]), SEARCH_URL).href : '',
    });
  }
  return out;
}

function blockedText(html) {
  return /captcha|cf-browser-verification|challenge-platform|access denied/i.test(html)
    && !/cert-paging-count|Keine Resultate/i.test(html);
}

async function readPage(term, page) {
  const url = searchUrl(term, page);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5' },
  });
  if (res.status === 403 || res.status === 429) return { fail: { reason: 'blocked', url, excerpt: `HTTP ${res.status}` } };
  if (!res.ok) return { fail: { reason: 'http_error', url, excerpt: `HTTP ${res.status}` } };
  const html = await res.text();
  if (blockedText(html)) return { fail: { reason: 'blocked', url, excerpt: 'bot check page' } };
  if (!/cert-paging-count|Keine Resultate/i.test(html)) {
    return { fail: { reason: 'layout_changed', url, excerpt: html.replace(/\s+/g, ' ').slice(0, 300) } };
  }
  return { html, url };
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await run(keyword);
  } catch (err) {
    answer = couldnt('other', SEARCH_URL, String(err && err.message ? err.message : err));
  }
  // Node 24 on Windows can abort with exit 127 if the process exits while a fetch socket is still closing.
  // A short pause lets the sockets close before the caller exits. Costs 1 s.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const term = stripLegal(kw);
  if (!term) return couldnt('other', SEARCH_URL, 'empty company name');
  const wantKey = key(kw);
  const firstUrl = searchUrl(term, 1);
  try {
    const all = [];
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) break;
      const got = await readPage(term, page);
      if (got.fail) return couldnt(got.fail.reason, got.fail.url, got.fail.excerpt);

      const t = got.html.match(/Anzahl Resultate:\s*(\d+)/i);
      const count = t ? Number(t[1]) : (/Keine Resultate/i.test(got.html) ? 0 : null);
      if (count === null) return couldnt('layout_changed', got.url, got.html.replace(/\s+/g, ' ').slice(0, 300));
      total = count;
      if (total === 0) break;

      const sections = parseSections(got.html);
      if (sections.length === 0) {
        if (page === 1) return couldnt('layout_changed', got.url, `Anzahl Resultate:${total} but no result entries found`);
        break;
      }
      all.push(...sections);
      if (all.length >= total) break;
    }

    const complete = total === 0 || all.length >= total;
    const exact = all.filter((r) => key(r.name) === wantKey);

    if (exact.length > 0) {
      const first = exact[0];
      return {
        status: 'found',
        reason: '',
        records: exact,
        source_url: firstUrl,
        excerpt: `${first.name} | ${first.customer_no} | ${first.address}`.slice(0, 500),
      };
    }
    if (!complete) {
      return couldnt('other', firstUrl, `read ${all.length} of ${total} results; no exact name match in those`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: total === 0 ? 'Keine Resultate' : `Anzahl Resultate:${total}; no customer named exactly "${kw}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', firstUrl, String(err && err.message ? err.message : err));
  }
}
