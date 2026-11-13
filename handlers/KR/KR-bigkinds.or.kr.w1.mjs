export const meta = {
  task: 'KR-bigkinds.or.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'provider', 'subtitle', 'category', 'byline', 'news_id', 'article_url'],
  canary: { found: '삼성전자', not_found: '퀀텀두부나라홀딩스주식회사' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://www.bigkinds.or.kr/api/news/search.do';
const RESULT_NUMBER = 20;

// Legal-form words removed before comparing names (Korean and English forms).
const LEGAL_FORMS = [/\(주\)/g, /㈜/g, /주식회사/g, /유한회사/g, /유한책임회사/g, /사단법인/g, /재단법인/g,
  /co\.?,?\s*ltd\.?/gi, /\binc\.?/gi, /\bcorp\.?/gi, /\bcorporation\b/gi, /\bltd\.?/gi, /\blimited\b/gi,
  /\bsdn\.?\s*bhd\.?/gi, /\bpte\.?\s*ltd\.?/gi, /\bllc\b/gi, /\bplc\b/gi];

function normalize(str) {
  let s = String(str || '');
  for (const re of LEGAL_FORMS) s = s.replace(re, ' ');
  return s.toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}

function ymd(s) {
  const d = String(s || '');
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

function todayPlusOne() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const core = normalize(name);
  const pageUrl = 'https://www.bigkinds.or.kr/v2/news/index.do';
  try {
    if (!core) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: 'empty company name' };
    }
    const body = {
      searchKey: name,
      searchKeys: [{}],
      indexName: 'news',
      searchFilterType: '1',
      searchScopeType: '1',
      searchSortType: 'LATEST',
      startDate: '1990-01-01',
      endDate: todayPlusOne(),
      startNo: 1,
      resultNumber: RESULT_NUMBER,
      highlighting: false,
      sortMethod: 'date',
      contentLength: 100,
      excel: false,
      maxNodes: 30,
      maxSentences: 5,
      maxNewsCount: 0,
      keyWindowSize: 50,
      edgeWindowSize: 100,
      sessionUUID: 'handler',
      keywordYn: 'Y',
      mainTodayPersonYn: 'N',
      isTmUsable: false,
      isNotTmUsable: false,
      interKoreaRelationService: 'N',
      analysisType: '',
      todayIssue: false,
    };
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json;charset=utf-8',
        'Accept': 'application/json',
        'Referer': pageUrl,
        'Origin': 'https://www.bigkinds.or.kr',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: API, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: API, excerpt: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      const looksLikeLogin = /로그인|login/i.test(text.slice(0, 2000));
      return {
        status: 'couldnt_check',
        reason: looksLikeLogin ? 'blocked' : 'layout_changed',
        records: [], source_url: API, excerpt: text.slice(0, 300),
      };
    }
    if (typeof d?.totalCount !== 'number' || !Array.isArray(d?.resultList)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: API, excerpt: text.slice(0, 300) };
    }
    if (d.errorCode || d.errorMessage) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: API,
        excerpt: `errorCode=${d.errorCode} ${String(d.errorMessage || '').slice(0, 200)}` };
    }

    const searchUrl = `https://www.bigkinds.or.kr/v2/news/search.do?keyword=${encodeURIComponent(name)}`;

    if (d.totalCount === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `0 articles for "${name}"` };
    }

    // The search matches the term anywhere in an article; only keep articles whose
    // visible text (title, subtitle, snippet) names the company after normalisation.
    const records = [];
    for (const r of d.resultList) {
      const title = cleanText(r.TITLE);
      const sub = cleanText(r.SUB_TITLE);
      const snippet = cleanText(r.CONTENT);
      const hay = normalize(`${title} ${sub} ${snippet}`);
      if (!hay.includes(core)) continue;
      records.push({
        title,
        date: ymd(r.DATE),
        provider: cleanText(r.PROVIDER),
        subtitle: sub,
        category: cleanText(r.CATEGORY_NAMES),
        byline: cleanText(r.BYLINE || r.byLine),
        news_id: String(r.NEWS_ID || ''),
        article_url: String(r.PROVIDER_LINK_PAGE || ''),
      });
    }

    if (records.length === 0) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: searchUrl,
        excerpt: `search matched ${d.totalCount} articles but none of the first ${d.resultList.length} shows "${name}" in its text; check by hand`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${d.totalCount} articles matched; ${records.length} of the first ${d.resultList.length} name the company. Newest: ${records[0].date} ${records[0].provider}: ${records[0].title}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other',
      records: [],
      source_url: API,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
