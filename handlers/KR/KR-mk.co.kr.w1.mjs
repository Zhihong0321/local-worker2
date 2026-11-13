export const meta = {
  task: 'KR-mk.co.kr',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'isin', 'price', 'change', 'change_rate'],
  canary: { found: '삼성전자', not_found: '가나다라마바사회사없음' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEARCH = 'https://stock.mk.co.kr/search/list?search_string=';

// Compare names: NFKC (turns ㈜ into (주)), lowercase, drop legal-form words and punctuation, drop spaces.
function normalize(str) {
  const legal = /(주식회사|유한책임회사|유한회사|합자회사|\(주\)|\(유\)|\(사\))/g;
  const words = (str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(legal, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !['inc', 'ltd', 'co', 'corp', 'llc', 'limited', 'company'].includes(w));
  return words.join('');
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  // The site's search does not match legal-form words, so search with the bare name.
  const bare = String(keyword || '')
    .normalize('NFKC')
    .replace(/(주식회사|유한책임회사|유한회사|합자회사|\(주\)|\(유\)|\(사\))/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const searchUrl = SEARCH + encodeURIComponent(bare || String(keyword || '').trim());
  try {
    const res = await fetch(searchUrl, {
      // Connection: close stops a keep-alive socket from being left open when the runner exits (Windows assertion).
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Connection': 'close' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();

    if (/Just a moment|cf-chl|captcha|로그인이 필요/i.test(html) && !html.includes('table-stock') && !html.includes('결과가 없습니다')) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: html.slice(0, 300) };
    }

    // The search section is the one headed "'<keyword>' 검색 결과".
    if (!/<h2 class="sec_ttl">[^<]*검색 결과<\/h2>/.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    // The site answered normally with no matches.
    if (html.includes('결과가 없습니다') && !html.includes('table-stock')) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: '검색결과가 없습니다 (no matching listed security)' };
    }

    const tableMatch = html.match(/<table class="table-stock[\s\S]*?<\/table>/);
    if (!tableMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const rows = (tableMatch[0].match(/<tr[\s\S]*?<\/tr>/g) || []).map((row) => {
      const link = row.match(/checkStock\('([^']+)'\)">([\s\S]*?)<\/a>/);
      if (!link) return null;
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map(cleanText);
      return {
        name: cleanText(link[2]),
        isin: link[1],
        price: cells[1] || '',
        change: cells[2] || '',
        change_rate: cells[3] || '',
      };
    }).filter(Boolean);

    if (rows.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(tableMatch[0]).slice(0, 300) };
    }

    const kwNorm = normalize(keyword);
    const matches = rows.filter((r) => normalize(r.name) === kwNorm);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `No listed security named exactly "${keyword}". Similar results only: ${rows.slice(0, 5).map((r) => r.name).join(' | ')}`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: searchUrl,
      excerpt: matches.map((r) => `${r.name} ${r.isin} ${r.price}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
