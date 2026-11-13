export const meta = {
  task: 'GB-naturalresources.wales',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'site_name', 'facility_address', 'permit_type', 'local_authority'],
  canary: { found: 'TATA Steel UK Ltd', not_found: 'Cwmni Dim Cofrestredig Cyfyngedig' },
};

const SEARCH_URL = 'https://publicregister.naturalresources.wales/Search/Results';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;     // the register shows 10 documents per page
const MAX_PAGES = 3;      // at most 30 documents are read per company name
const TIME_BUDGET_MS = 40000; // do not start a new page after 40 s, so the whole call stays under 60 s
const MAX_RECORDS = 50;

// Trailing legal-form words that are dropped before two names are compared.
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'incorporated', 'co', 'cyf', 'cyfyngedig', 'cic']);

/** Case, accents, punctuation and trailing legal form removed: "Dŵr Cymru Cyfyngedig." -> "dwr cymru". */
function normalize(text) {
  let s = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const parts = s.split(' ').filter(Boolean);
  while (parts.length > 1 && LEGAL_FORMS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** Turns an HTML fragment into plain text with the common entities decoded. */
function decodeText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x2019;|&#8217;/gi, '’')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchUrl(keyword, page) {
  const u = new URL(SEARCH_URL);
  u.searchParams.set('SearchTerm', keyword);
  if (page > 1) u.searchParams.set('pageNumber', String(page));
  return u.href;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Reads one result block (one document) into the fields the register shows. */
function parseBlock(block) {
  const pick = (re) => {
    const m = block.match(re);
    return m ? decodeText(m[1]) : '';
  };
  return {
    name: pick(/<label>\s*Customer name:?\s*<\/label>\s*<span>([\s\S]*?)<\/span>/),
    site_name: pick(/<label>\s*Site name:?\s*<\/label>\s*<span>([\s\S]*?)<\/span>/),
    facility_address: pick(/<label>\s*Facility address:?\s*<\/label>\s*<span>([\s\S]*?)<\/span>/),
    permit_type: pick(/<label>\s*License\/Activity Type:?\s*<\/label>\s*<span>([\s\S]*?)<\/span>/),
    local_authority: pick(/<label>\s*Welsh Local Authority:?\s*<\/label>\s*<span>([\s\S]*?)<\/span>/),
  };
}

/** Splits a results page into its documents. */
function splitResults(html) {
  const parts = html.split('<div class="search-result" ');
  return parts.slice(1).map((p) => parseBlock(p));
}

/** The "Your search returned N results" line, or null if the page has no such line. */
function resultTotal(html) {
  const m = html.match(/Your search returned\s+([\d,]+)\s+results?/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Short settle pause: on Windows the worker's Node process can abort while the last keep-alive socket closes
  // right after a fast answer (seen on 0-result pages). The pause lets the socket close first. Exit code 0, same answer.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const name = String(keyword || '').trim();
  const firstUrl = name ? searchUrl(name, 1) : SEARCH_URL;
  try {
    if (!normalize(name)) {
      return couldnt('other', firstUrl, 'the company name has no letters or numbers to search for');
    }
    const wanted = normalize(name);
    const started = Date.now();
    const records = [];
    const seen = new Set();
    const matchedSites = new Set();
    let total = null;
    let checked = 0;
    let firstSearchUrl = firstUrl;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > TIME_BUDGET_MS) break;
      const url = searchUrl(name, page);
      if (page === 1) firstSearchUrl = url;

      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9,cy;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 403 || res.status === 429) {
        return couldnt('blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return couldnt('http_error', url, `HTTP ${res.status}`);
      }

      const html = await res.text();
      if (/captcha|access denied|are you a robot|verify you are human/i.test(html.slice(0, 20000))) {
        return couldnt('blocked', url, 'bot check or access denied page');
      }

      const count = resultTotal(html);
      if (count === null) {
        return couldnt('layout_changed', url, html.replace(/\s+/g, ' ').slice(0, 300));
      }

      if (page === 1) {
        total = count;
        if (count === 0) {
          return {
            status: 'not_found',
            reason: '',
            records: [],
            source_url: url,
            excerpt: `Your search returned 0 results for "${name}"`,
          };
        }
      }

      const docs = splitResults(html);
      checked += docs.length;
      for (const doc of docs) {
        if (normalize(doc.name) !== wanted) continue;
        const key = [doc.name, doc.site_name, doc.facility_address, doc.permit_type].join('|');
        matchedSites.add(doc.site_name + '|' + doc.facility_address);
        if (seen.has(key)) continue;
        seen.add(key);
        if (records.length < MAX_RECORDS) records.push(doc);
      }

      if (docs.length < PAGE_SIZE) break;
      if (total !== null && page * PAGE_SIZE >= total) break;
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstSearchUrl,
        excerpt: `${total} documents match "${name}"; ${matchedSites.size} site(s) with customer name "${records[0].name}" in the first ${checked} read`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstSearchUrl,
      excerpt: `Register returned ${total} results for "${name}"; none of the first ${checked} has customer name matching it`,
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(isTimeout ? 'timeout' : 'other', firstUrl, String(err?.message || err));
  }
}
