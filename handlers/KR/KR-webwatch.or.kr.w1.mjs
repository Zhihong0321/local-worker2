export const meta = {
  task: 'KR-webwatch.or.kr',
  want: 'w1',
  tier: 1,
  method: 'get',
  input: 'company name',
  fields: ['name', 'site_name', 'site_url', 'validity_period', 'status'],
  canary: {
    found: '(주)플랜아이',
    not_found: '(주)디자인피버',
  },
};

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\(주\)|㈜|\(유\)|주식회사|유한회사|\(합\)|\(사\)|\(재\)/g, '')
    .replace(/[^a-z0-9가-힣]/g, '');
}

function cleanQuery(q) {
  const cleaned = (q || '')
    .replace(/\((주|유|합|사|재)\)/g, '')
    .replace(/[㈜㈲㈳㈴]/g, '')
    .replace(/^(주식회사|유한회사|합자회사|사단법인|재단법인)\s*/, '')
    .replace(/\s*(주식회사|유한회사|합자회사|사단법인|재단법인)$/, '')
    .replace(/[\(\)\[\]]/g, '')
    .trim();
  return cleaned || (q ? q.trim() : '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://webwatch.or.kr/watch/certify/wa/list',
        excerpt: '',
      };
    }

    const q = cleanQuery(keyword);
    const searchUrl = 'https://webwatch.or.kr/watch/certify/wa/list?searchType=all&pageOffset=100&keyword=' + encodeURIComponent(q);

    let res;
    try {
      res = await fetch(searchUrl, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: '' };
      }
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: '' };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: '' };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: '' };
    }

    const html = await res.text();

    // Verify page layout markers
    if (!html.includes('responsive-tbl') || !html.includes('웹 인증')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: '' };
    }

    // Check if site explicitly reported no records
    if (html.includes('조회된 데이터가 존재하지 않습니다')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    // Extract table rows from tbody
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: '' };
    }

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    const items = [];

    while ((match = rowRegex.exec(tbodyMatch[1])) !== null) {
      const row = match[1];
      if (row.includes('조회된 데이터가 존재하지 않습니다')) continue;

      const numM = row.match(/<span class="site-number">(.*?)<\/span>/);
      const siteM = row.match(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const orgM = row.match(/<span class="organization[^"]*">\s*([\s\S]*?)\s*<\/span>/);
      const times = [...row.matchAll(/<time>(.*?)<\/time>/g)].map(m => m[1].trim());
      const statusM = row.match(/<span class="badge[^"]*">\s*([\s\S]*?)\s*<\/span>/);

      const orgName = orgM ? orgM[1].replace(/<[^>]+>/g, '').trim() : '';
      const siteName = siteM ? siteM[2].replace(/<[^>]+>/g, '').trim() : '';
      const siteUrl = siteM ? siteM[1].trim() : '';
      const validity = times.length ? times.join(' ~ ') : '';
      const status = statusM ? statusM[1].replace(/<[^>]+>/g, '').trim() : '';

      if (orgName || siteName) {
        items.push({
          name: orgName,
          site_name: siteName,
          site_url: siteUrl,
          validity_period: validity,
          status: status,
        });
      }
    }

    if (items.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    // Match against target keyword
    const targetNorm = normalize(keyword);
    let matched = items.filter(item => {
      const orgNorm = normalize(item.name);
      const siteNorm = normalize(item.site_name);
      return orgNorm.includes(targetNorm) || targetNorm.includes(orgNorm) ||
             siteNorm.includes(targetNorm) || targetNorm.includes(siteNorm);
    });

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: '',
      };
    }

    const records = matched.map(item => ({
      name: item.name,
      site_name: item.site_name,
      site_url: item.site_url,
      validity_period: item.validity_period,
      status: item.status,
    }));

    const first = matched[0];
    const excerpt = (`[웹 인증] ${first.name} | 사이트: ${first.site_name} (${first.site_url}) | 유효기간: ${first.validity_period} | 상태: ${first.status}`).slice(0, 500);

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://webwatch.or.kr/watch/certify/wa/list',
      excerpt: '',
    };
  }
}
