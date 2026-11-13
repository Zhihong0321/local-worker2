export const meta = { task: 'VN-ssc.gov.vn', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['doc_id', 'title', 'document_url'],
  canary: { found: 'Vinacomin – Coal Import-Export Joint Stock Company', not_found: 'Công ty Cổ phần Zzqxwvk Không Tồn Tại' } };

// The SSC site (Oracle WebCenter/UCM) has a public document search at /cs/idcplg?IdcService=GET_SEARCH_RESULTS.
// A title query on one word returns the matching documents; the handler then checks the full company name against each title.
const BASE = 'https://ssc.gov.vn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RESULT_COUNT = 100;

// Legal-form words, removed from both the typed name and the site titles before comparing.
const LEGAL_WORDS = new Set(['ctcp', 'tnhh', 'cty', 'cong', 'ty', 'co', 'phan', 'trach', 'nhiem', 'huu', 'han',
  'doanh', 'nghiep', 'joint', 'stock', 'company', 'limited', 'ltd', 'jsc', 'llc', 'corp', 'corporation', 'cp']);

/** Lower-case, no diacritics, one token per letter/digit run. */
function normTokens(s) {
  return String(s || '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** Split the typed name into words that keep their diacritics (the site search needs them as typed). */
function rawWords(s) {
  return String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function containsSeq(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function decodeTitle(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

const cc = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const words = rawWords(keyword);
    const coreNorm = normTokens(keyword).filter((t) => !LEGAL_WORDS.has(t));
    if (coreNorm.length === 0) return cc('other', '', 'no company name in the keyword');

    // One distinctive word goes to the site search; the full name is checked against each title below.
    const searchWord = words
      .filter((w) => !normTokens(w).every((t) => LEGAL_WORDS.has(t)))
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    const q = `dDocTitle <substring> \`${searchWord}\``;
    searchUrl = `${BASE}/cs/idcplg?IdcService=GET_SEARCH_RESULTS&QueryText=${encodeURIComponent(q)}`
      + `&SearchProvider=Internal&ResultTemplate=&SortField=dInDate&SortOrder=Desc&ResultCount=${RESULT_COUNT}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return cc('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return cc('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const status = html.match(/StatusMessage = "([^"]*)"/);
    if (status && status[1]) return cc('other', searchUrl, 'site refused the search: ' + status[1].slice(0, 200));
    if (!html.includes('Search Results')) {
      return cc('layout_changed', searchUrl, html.replace(/\s+/g, ' ').slice(0, 300));
    }

    // Each result row carries its document id and title in a checkOutAndOpen8('id','title', ...) call.
    const hits = new Map();
    const re = /checkOutAndOpen8\('([A-Za-z0-9_]+)','((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(html))) {
      if (!hits.has(m[1])) hits.set(m[1], decodeTitle(m[2]));
    }

    const records = [];
    for (const [id, title] of hits) {
      if (containsSeq(normTokens(title), coreNorm)) {
        records.push({
          doc_id: id,
          title,
          document_url: `${BASE}/webcenter/portal/ubck/pages_r/l/chitit?dDocName=${id}`,
        });
      }
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: searchUrl, excerpt: records[0].title.slice(0, 500) };
    }
    if (hits.size >= RESULT_COUNT) {
      return cc('other', searchUrl, `search returned ${hits.size} documents (the page limit); the name could be further down`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `site search for "${searchWord}" returned ${hits.size} document(s); none names this company`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err).slice(0, 300));
  }
}
