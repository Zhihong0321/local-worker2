/**
 * Site handler probe for KR-kipfa.or.kr
 * Korea Internet Professionals Association Corporate Members (한국인터넷전문가협회 단체회원사)
 */

export const meta = {
  task: 'KR-kipfa.or.kr',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'biz_num', 'representative', 'website', 'phone', 'address'],
  canary: {
    found: '(주)플랜아이',
    not_found: '당근마켓',
  },
};

const BASE_URL = 'https://www.kipfa.or.kr/Information/InternetProCorpList.aspx';
const DETAIL_BASE_URL = 'https://www.kipfa.or.kr/Information/InternetProCorpGroupView.aspx';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function cleanText(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: BASE_URL,
      excerpt: '',
    };
  }

  const trimmedKeyword = keyword.trim();

  try {
    // Step 1: Initial GET to fetch ASP.NET __VIEWSTATE and __VIEWSTATEGENERATOR
    const getRes = await fetch(BASE_URL, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (getRes.status === 403 || getRes.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    if (!getRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    const getHtml = await getRes.text();

    // Verify layout markers on GET page
    const vsMatch = getHtml.match(/id="__VIEWSTATE"\s+value="([^"]+)"/);
    const vsgMatch = getHtml.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/);
    const hasSearchForm = getHtml.includes('KEYWORD') && getHtml.includes('submitBtn');

    if (!vsMatch || !hasSearchForm) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    const viewState = vsMatch[1];
    const viewStateGenerator = vsgMatch ? vsgMatch[1] : '';

    // Step 2: Form POST search with keyword
    await delay(1000);

    const postData = new URLSearchParams({
      '__VIEWSTATE': viewState,
      '__VIEWSTATEGENERATOR': viewStateGenerator,
      'INITIAL1': '',
      'INITIAL2': '',
      'BIZ_TYPE': '',
      'SALE_SCALE': '',
      'MEMBER_COUNT': '',
      'EMPLOYEE_COUNT': '',
      'LOC': '',
      'KEYWORD': trimmedKeyword,
      'submitBtn.x': '10',
      'submitBtn.y': '10',
    });

    const postRes = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': BASE_URL,
      },
      body: postData.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (postRes.status === 403 || postRes.status === 429) {
      return {
        status: 'couldnt_check',
        reason: 'blocked',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    if (!postRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    let postHtml = await postRes.text();

    // Layout check on POST response: tabletype1 must be present
    if (!postHtml.includes('tabletype1')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    // Parse search results
    const itemRegex = /onclick=["']detailopen\((\d+)\)["'][\s\S]*?<h4>([\s\S]*?)<\/h4>/gi;
    let matches = [];
    let match;
    while ((match = itemRegex.exec(postHtml)) !== null) {
      matches.push({
        seqno: match[1],
        name: cleanText(match[2]),
      });
    }

    // If 0 matches, and keyword contained corporate affixes or spaces, try simplified core name
    const cleanedKeyword = trimmedKeyword
      .replace(/^\s*\((?:주|유|사)\)\s*/, '')
      .replace(/\s*\((?:주|유|사)\)\s*$/, '')
      .replace(/^\s*주식회사\s*/, '')
      .replace(/\s*주식회사\s*$/, '')
      .trim();

    if (matches.length === 0 && cleanedKeyword && cleanedKeyword !== trimmedKeyword) {
      await delay(1000);
      const retryPostData = new URLSearchParams({
        '__VIEWSTATE': viewState,
        '__VIEWSTATEGENERATOR': viewStateGenerator,
        'INITIAL1': '',
        'INITIAL2': '',
        'BIZ_TYPE': '',
        'SALE_SCALE': '',
        'MEMBER_COUNT': '',
        'EMPLOYEE_COUNT': '',
        'LOC': '',
        'KEYWORD': cleanedKeyword,
        'submitBtn.x': '10',
        'submitBtn.y': '10',
      });

      const retryRes = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': BASE_URL,
        },
        body: retryPostData.toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (retryRes.ok) {
        postHtml = await retryRes.text();
        if (postHtml.includes('tabletype1')) {
          itemRegex.lastIndex = 0;
          while ((match = itemRegex.exec(postHtml)) !== null) {
            matches.push({
              seqno: match[1],
              name: cleanText(match[2]),
            });
          }
        }
      }
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }

    // Step 3: Fetch detail page for the primary matching company
    const primary = matches[0];
    const detailUrl = `${DETAIL_BASE_URL}?SEQNO=${primary.seqno}`;

    try {
      await delay(1000);
      const detailRes = await fetch(detailUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': BASE_URL,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (detailRes.ok) {
        const detailHtml = await detailRes.text();
        const thTdRegex = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
        const details = {};
        let dMatch;
        while ((dMatch = thTdRegex.exec(detailHtml)) !== null) {
          const k = cleanText(dMatch[1]);
          const v = cleanText(dMatch[2]);
          if (k) details[k] = v;
        }

        const name = details['한글 업체명'] || primary.name;
        const bizNum = details['사업자 등록번호'] || '';
        const rep = details['대표자명'] || '';
        const site = details['웹사이트주소'] || '';
        const phone = details['전화번호'] || '';
        const addr = details['회사주소'] || '';

        const record = {
          name,
          biz_num: bizNum,
          representative: rep,
          website: site,
          phone,
          address: addr,
        };

        const excerptParts = [];
        if (name) excerptParts.push(`한글 업체명: ${name}`);
        if (bizNum) excerptParts.push(`사업자 등록번호: ${bizNum}`);
        if (rep) excerptParts.push(`대표자명: ${rep}`);
        if (site) excerptParts.push(`웹사이트주소: ${site}`);
        if (phone) excerptParts.push(`전화번호: ${phone}`);
        if (addr) excerptParts.push(`회사주소: ${addr}`);

        return {
          status: 'found',
          reason: '',
          records: [record],
          source_url: detailUrl,
          excerpt: excerptParts.join(' | ').slice(0, 500),
        };
      }
    } catch {
      // If detail fetch fails, fall back to search result
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((m) => ({
        name: m.name,
        biz_num: '',
        representative: '',
        website: '',
        phone: '',
        address: '',
      })),
      source_url: BASE_URL,
      excerpt: matches.map((m) => m.name).join(', ').slice(0, 500),
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        status: 'couldnt_check',
        reason: 'timeout',
        records: [],
        source_url: BASE_URL,
        excerpt: '',
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE_URL,
      excerpt: '',
    };
  }
}
