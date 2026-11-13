export const meta = {
  task: 'KR-daara.co.kr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'seller_id', 'phone', 'address', 'homepage', 'verified', 'listed_products', 'product_examples'],
  canary: { found: '(주)세영엠티테크', not_found: '존재하지않는회사명가나다라' },
};

const BASE = 'https://www.daara.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_CANDIDATES = 40;   // product pages read per lookup; more than this is reported as couldnt_check
const CONCURRENCY = 8;       // product pages read at the same time
const NO_NEW_FETCH_AFTER_MS = 30000; // no new product page is started after this, so the call ends under 60 s
const REASON_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

function decode(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/gi, (m, e) => map[e.toLowerCase()] ?? m);
}

function cleanText(html) {
  return decode((html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Legal-form marks and words are removed before two names are compared.
function stripLegalForm(s) {
  return s
    .replace(/\(주\)|㈜|\(유\)|\(사\)|\(재\)|\(합\)/g, ' ')
    .replace(/주식회사|유한회사|합자회사|합명회사|사단법인|재단법인/g, ' ')
    .replace(/\b(co\.?\s*,?\s*ltd\.?|company|limited|inc\.?|corp\.?|corporation|llc|sdn\.?\s*bhd\.?)(?=\W|$)/gi, ' ');
}

function norm(s) {
  return stripLegalForm(String(s).normalize('NFKC')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normNoParens(s) {
  return norm(String(s).replace(/\([^)]*\)/g, ' '));
}

function sameCompany(a, b) {
  const x = norm(a);
  if (x && x === norm(b)) return true;
  const px = normNoParens(a);
  return px.length > 0 && px === normNoParens(b);
}

function searchTerm(keyword) {
  const withoutBrackets = stripLegalForm(String(keyword).normalize('NFKC')).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutBrackets) return withoutBrackets;
  return stripLegalForm(String(keyword).normalize('NFKC')).replace(/\s+/g, ' ').trim();
}

function searchUrl(term) {
  return `${BASE}/search/quick.php?lang=ko&prod_num=100&search_key=${encodeURIComponent(term)}`;
}

function detailUrl(no) {
  return `${BASE}/sell/s_view.php?no=${no}&lang=ko`;
}

async function getText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = res.ok ? await res.text() : '';
  return { status: res.status, ok: res.ok, text };
}

function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

function httpReason(status) {
  return status === 403 || status === 429 ? 'blocked' : 'http_error';
}

const BLOCK_RE = /captcha|access denied|자동입력 방지|접근이 차단/i;

/** Products on the search page: the product number and title for each result card. */
function listItems(html) {
  const start = html.indexOf('class="quick-product-list"');
  if (start < 0) return { cards: 0, items: [] };
  const end = html.indexOf('site-footer', start);
  const area = html.slice(start, end > start ? end : undefined);
  const parts = area.split(/<article class="quick-product-item">/).slice(1);
  const seen = new Set();
  const items = [];
  for (const p of parts) {
    const m = p.match(/s_view\.php%3Fno%3D(\d+)/i);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const t = p.match(/<h3 class="quick-product-item__title">([\s\S]*?)<\/h3>/);
    items.push({ no: m[1], title: t ? cleanText(t[1]) : '' });
  }
  return { cards: parts.length, items };
}

/** The seller card on a product page: company name, verified flag, contact table, number of products. */
function parseSeller(html) {
  const t = html.match(/<h3[^>]*class="company-card__title"[^>]*>([\s\S]*?)<\/h3>/);
  if (!t) return null;
  const name = cleanText(t[1]);
  if (!name) return null;

  const cid = (html.match(/cid=([\w.-]+)/) || [])[1] || '';
  const verified = html.includes('사업자 정보 확인 완료');
  const count = (html.match(/판매제품[\s\S]{0,300}?<strong>(\d+)<\/strong>/) || [])[1];

  const fields = {};
  const ts = html.indexOf('company-card__table');
  const te = ts >= 0 ? html.indexOf('</table>', ts) : -1;
  if (ts >= 0 && te > ts) {
    for (const m of html.slice(ts, te).matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
      const label = cleanText(m[1]);
      const value = cleanText(m[2]);
      if (label.includes('문의전화')) fields.phone = value;
      else if (label.includes('주소')) fields.address = value;
      else if (label.includes('홈페이지')) fields.homepage = value;
    }
  }
  return {
    name,
    cid,
    verified,
    listed: count ? Number(count) : null,
    phone: fields.phone || '',
    address: fields.address || '',
    homepage: fields.homepage || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const kw = String(keyword || '').trim();
  const term = searchTerm(kw);
  if (!term) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
  }
  const url = searchUrl(term);

  try {
    // Step 1: product search. The site matches product titles and seller names.
    const s = await getText(url);
    if (!s.ok) {
      return { status: 'couldnt_check', reason: httpReason(s.status), records: [], source_url: url, excerpt: `HTTP ${s.status}` };
    }
    const { cards, items } = listItems(s.text);
    if (items.length === 0) {
      if (!s.text.includes('quick-product-list')) {
        const reason = BLOCK_RE.test(s.text) ? 'blocked' : 'layout_changed';
        return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: cleanText(s.text).slice(0, 300) };
      }
      if (cards === 0 && s.text.includes('검색된 제품이 없습니다')) {
        return { status: 'not_found', reason: '', records: [], source_url: url, excerpt: `No products found for "${term}" (검색된 제품이 없습니다)` };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(s.text).slice(0, 300) };
    }

    // Step 2: read the seller of each product found and compare names.
    const candidates = items.slice(0, MAX_CANDIDATES);
    const truncated = items.length > MAX_CANDIDATES;
    const matches = new Map();
    const failures = [];
    let next = 0;

    const worker = async () => {
      while (next < candidates.length) {
        const item = candidates[next++];
        if (Date.now() - t0 > NO_NEW_FETCH_AFTER_MS) {
          failures.push('timeout');
          continue;
        }
        let d;
        try {
          d = await getText(detailUrl(item.no));
        } catch (e) {
          failures.push(errReason(e));
          continue;
        }
        if (!d.ok) {
          failures.push(httpReason(d.status));
          continue;
        }
        const seller = parseSeller(d.text);
        if (!seller) {
          failures.push(BLOCK_RE.test(d.text) ? 'blocked' : 'layout_changed');
          continue;
        }
        if (!sameCompany(seller.name, kw) && !sameCompany(seller.name, term)) continue;

        const key = seller.cid || seller.name;
        if (!matches.has(key)) {
          matches.set(key, { ...seller, product_examples: [] });
        }
        const rec = matches.get(key);
        if (rec.product_examples.length < 3) {
          rec.product_examples.push({ no: item.no, title: item.title, url: detailUrl(item.no) });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

    if (matches.size > 0) {
      const records = [...matches.values()].map((r) => ({
        name: r.name,
        seller_id: r.cid,
        phone: r.phone,
        address: r.address,
        homepage: r.homepage,
        verified: r.verified,
        listed_products: r.listed,
        product_examples: r.product_examples,
      }));
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: url,
        excerpt: cleanText(`${first.name} | ${first.verified ? '사업자 정보 확인 완료' : ''} | 판매제품 ${first.listed_products ?? '?'}개 | ${first.address}`).slice(0, 500),
      };
    }

    if (truncated) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: url,
        excerpt: `The search returned ${items.length} products; the first ${MAX_CANDIDATES} were read and none is sold by "${kw}". The rest could not be checked.`,
      };
    }

    if (failures.length > 0) {
      const reason = REASON_ORDER.find((r) => failures.includes(r)) || 'other';
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: url,
        excerpt: `${failures.length} of ${candidates.length} product pages could not be read (${[...new Set(failures)].join(', ')}).`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: url,
      excerpt: `${candidates.length} products matched "${term}"; none is sold by a company named "${kw}".`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: errReason(err) === 'timeout' ? 'timeout' : 'other',
      records: [],
      source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
