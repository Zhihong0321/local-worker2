export const meta = {
  task: 'JP-nagoya-cci.or.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'prefecture', 'city', 'summary', 'detail_url'],
  canary: { found: '株式会社エスプリ', not_found: 'ドゥエゼノ株式会社' },
};

// The chamber's own company lookup ("名商の会員検索はこちら", linked from
// https://www.nagoya-cci.or.jp/koryu/mall.html) is hosted on b-mall.ne.jp, the chambers' shared company database.
// It is a plain GET keyword search, no login, no captcha.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.b-mall.ne.jp';

const LEGAL_JA = ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '相互会社', '一般社団法人', '一般財団法人',
  '公益社団法人', '公益財団法人', '特定非営利活動法人', '社団法人', '財団法人', '医療法人', '学校法人', '社会福祉法人',
  '税理士法人', '弁護士法人', '司法書士法人', '行政書士法人', '協同組合'];
const LEGAL_EN = ['coltd', 'ltd', 'limited', 'corporation', 'corp', 'inc', 'kk'];

/** Normalised name for comparison: NFKC, lower case, no spaces or punctuation, no legal form. */
function core(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(/[（(]\s*(株|有|合|名|資)\s*[)）]/g, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, '');
  for (const f of LEGAL_JA) t = t.split(f).join('');
  for (const f of LEGAL_EN) t = t.replace(new RegExp(`^${f}|${f}$`, 'g'), '');
  return t;
}

function cleanText(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const out = await run(keyword);
  // Let the sockets close before the runner calls process.exit (Node 24 on Windows asserts otherwise).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return out;
}

async function run(keyword) {
  const kw = String(keyword || '').trim();
  // The site's keyword search misses "(株)" style marks, so search by the name without the legal form.
  // That returns a superset of the exact name; the exact comparison below still decides the match.
  let term = kw.normalize('NFKC').replace(/[（(]\s*(株|有|合|名|資)\s*[)）]/g, '');
  for (const f of LEGAL_JA) term = term.split(f).join('');
  term = term.replace(/\s+/g, ' ').trim() || kw;
  const searchUrl = `${BASE}/nagoya/companysearch?keyword=${encodeURIComponent(term)}`;
  try {
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty keyword' };
    }

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|Access Denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    const totalMatch = html.match(/企業ＤＢ検索結果[：:]\s*([\d,]+)件/);
    if (!totalMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    const total = Number(totalMatch[1].replace(/,/g, ''));

    const table = html.match(/<table class="SearchResult"[\s\S]*?<\/table>/)?.[0] || '';
    const rows = (table.match(/<tr>[\s\S]*?<\/tr>/g) || []).filter((r) => /class="like-anchor"/.test(r));
    const listed = rows.map((row) => {
      const link = row.match(/<a class="like-anchor" href='(\/CompanyDetail-[^']+)'>([\s\S]*?)<\/a>/);
      const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
      const places = (tds[2] || '').match(/<span>([\s\S]*?)<\/span>/g) || [];
      return {
        name: cleanText(link ? link[2] : ''),
        prefecture: places[0] ? cleanText(places[0]) : '',
        city: places[1] ? cleanText(places[1]) : '',
        summary: cleanText(tds[3] || ''),
        detail_url: link ? new URL(link[1], BASE).href : '',
      };
    });

    const matches = listed.filter((r) => core(r.name) && core(r.name) === core(kw));
    if (matches.length) {
      return {
        status: 'found', reason: '', records: matches, source_url: searchUrl,
        excerpt: matches.map((m) => `${m.name} | ${m.prefecture} ${m.city}`).join(' ; ').slice(0, 500),
      };
    }
    if (total > listed.length) {
      // Page 1 holds 20 results; the match may be on a later page, so do not say "not listed".
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: `${total} results, only the first ${listed.length} shown; no exact match among them`,
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `企業ＤＢ検索結果：${total}件 for ${kw}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
