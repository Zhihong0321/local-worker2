export const meta = { task: 'KR-teamblind.com', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'url', 'rating'],
  canary: { found: '엘티씨', not_found: '드물게없는회사명가나다라' } };

const SITE = 'https://www.teamblind.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CARD_MARK = 'class="w_company w_company_review"';

/** Strip Korean and English legal-form words so "주식회사 엘티씨", "(주)엘티씨" and "엘티씨" compare equal. */
function core(name) {
  let s = String(name || '').normalize('NFKC').toLowerCase();
  s = s.replace(/주식회사|유한회사|합자회사|합명회사|\(주\)|\(유\)|\(합\)/g, ' ');
  s = s.replace(/\b(co\.?\s*,?\s*ltd\.?|ltd\.?|limited|inc\.?|corp\.?|corporation|pte\.?|sdn\.?\s*bhd\.?|berhad|llc|gmbh|plc|co\.?)(?=\W|$)/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Letters and digits only, for an exact comparison. */
function key(name) {
  return core(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = '';
  try {
    const term = core(keyword) || String(keyword || '').trim();
    if (!term) return fail('couldnt_check', 'other', SITE + '/kr/', 'empty company name');
    searchUrl = `${SITE}/kr/search/${encodeURIComponent(term)}`;

    let res;
    try {
      res = await fetch(searchUrl, {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'ko-KR,ko;q=0.9,en;q=0.7',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return fail('couldnt_check', timedOut ? 'timeout' : 'other', searchUrl, e?.message || e);
    }

    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);
    if (/\/(login|signin|sign-in)/i.test(res.url || '')) return fail('couldnt_check', 'blocked', searchUrl, `redirected to ${res.url}`);

    const html = await res.text();

    if (!html.includes('검색결과')) {
      // A short page with a challenge marker is a bot check; anything else is a page we do not recognise.
      if (html.length < 60000 && /captcha|cf-chl|challenge-platform|Just a moment|접근이 제한/i.test(html)) {
        return fail('couldnt_check', 'blocked', searchUrl, 'bot check page');
      }
      return fail('couldnt_check', 'layout_changed', searchUrl, html.slice(0, 300));
    }

    // Company cards: each card starts with CARD_MARK and holds its name link and rating.
    const cards = html.split(CARD_MARK).slice(1).map((block) => {
      const nm = block.match(/<a href="(\/kr\/company\/[^"]+)" class="name">([\s\S]*?)<\/a>/);
      if (!nm) return null;
      const rating = block.match(/<span class="star"><i class="blind">Rating Score<\/i>\s*([\d.]+)<\/span>/);
      return { name: decode(nm[2]), url: SITE + nm[1], rating: rating ? Number(rating[1]) : null };
    }).filter(Boolean);

    const wanted = key(keyword);
    const matches = cards.filter((c) => wanted && key(c.name) === wanted);

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((c) => ({ name: c.name, url: c.url, rating: c.rating })),
        source_url: searchUrl,
        excerpt: `Company listed on Blind Korea: ${matches.map((c) => c.name).join(', ')}`.slice(0, 300),
      };
    }

    // The search page answered normally; no company card has this name.
    const nearest = cards.map((c) => c.name).slice(0, 5).join(', ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: cards.length
        ? `No company named "${keyword}"; the search showed other companies: ${nearest}`.slice(0, 300)
        : `No company results for "${keyword}"`,
    };
  } catch (err) {
    return fail('couldnt_check', 'other', searchUrl || SITE + '/kr/', err?.message || err);
  }
}
