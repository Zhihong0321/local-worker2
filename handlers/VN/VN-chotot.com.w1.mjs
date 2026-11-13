export const meta = {
  task: 'VN-chotot.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['company_name', 'account_name', 'shop_name', 'is_shop_verified', 'ad_subject', 'list_id', 'region_name', 'list_time'],
  canary: { found: 'Công ty TNHH Sức Bật - Spiral', not_found: 'Công ty TNHH Hư Không Bất Tận' },
};

// Chợ Tốt has no company register. Its search page (/mua-ban?q=...) lists classified ads, and some ads carry the
// company name the poster typed in the "company_name" field (job ads, shops). This handler searches that page and
// keeps the ads whose company_name matches the keyword after normalisation (case, accents, punctuation, legal form).
const BASE = 'https://www.chotot.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;
const MAX_PAGES = 5;
const BUDGET_MS = 40000;

const LEGAL_PREFIXES = ['cong ty co phan', 'cong ty tnhh mot thanh vien', 'cong ty tnhh mtv', 'cong ty tnhh', 'cong ty',
  'cty tnhh', 'cty', 'tnhh mot thanh vien', 'tnhh mtv', 'tnhh', 'co phan', 'dntn', 'hkd', 'ho kinh doanh', 'doanh nghiep tu nhan'];
const LEGAL_SUFFIXES = ['pte ltd', 'sdn bhd', 'co ltd', 'ltd', 'llc', 'jsc', 'inc', 'corp', 'limited'];

/** Normalised key of a company name: no accents, no case, no punctuation, no legal form, no spaces. */
function coreKey(str) {
  let words = (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of LEGAL_PREFIXES) {
      const pw = p.split(' ');
      if (words.length > pw.length && pw.every((w, i) => words[i] === w)) { words = words.slice(pw.length); changed = true; break; }
    }
    for (const s of LEGAL_SUFFIXES) {
      const sw = s.split(' ');
      if (words.length > sw.length && sw.every((w, i) => words[words.length - sw.length + i] === w)) {
        words = words.slice(0, words.length - sw.length); changed = true; break;
      }
    }
  }
  return words.join('');
}

function extractAdlisting(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const data = JSON.parse(m[1])?.props?.initialState?.adlisting?.data;
  if (!data || !Array.isArray(data.ads) || typeof data.total !== 'number') return null;
  return data;
}

function looksBlocked(html) {
  return /captcha|cf-challenge|Just a moment|verify you are human|Access denied/i.test(html);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // On Windows the runner exits right after the answer; without a short pause the open sockets can hit a libuv
  // assertion at exit (exit code 127) even though the answer was printed. The pause lets them close first.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const searchUrl = `${BASE}/mua-ban?q=${encodeURIComponent(keyword)}`;
  try {
    const want = coreKey(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: 'the company name has no letters or digits to compare' };
    }

    const records = [];
    let total = null;
    let scanned = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > BUDGET_MS) break;
      const url = page === 1 ? searchUrl : `${BASE}/mua-ban?page=${page}&q=${encodeURIComponent(keyword)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.7',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const html = await res.text();
      const data = extractAdlisting(html);
      if (!data) {
        const blocked = !html.includes('__NEXT_DATA__') && looksBlocked(html);
        return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url: url,
          excerpt: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
      }

      total = data.total;
      scanned += data.ads.length;
      for (const ad of data.ads) {
        if (coreKey(ad.company_name) === want) {
          records.push({
            company_name: ad.company_name,
            account_name: ad.account_name ?? '',
            shop_name: ad.shop_name ?? '',
            is_shop_verified: !!ad.is_shop_verified,
            ad_subject: ad.subject ?? '',
            list_id: ad.list_id ?? null,
            region_name: ad.region_name ?? '',
            list_time: ad.list_time ?? ad.date ?? '',
          });
        }
      }
      if (data.ads.length < PAGE_SIZE || scanned >= total) break;
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: records.slice(0, 100),
        source_url: searchUrl,
        excerpt: `${records.length} ad(s) with a matching company name, out of ${total} results for "${keyword}"`,
      };
    }
    if (total !== null && scanned >= total) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `0 ads with this company name among ${total} results for "${keyword}"`,
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: `checked ${scanned} of ${total ?? '?'} results for "${keyword}" within the time limit; no matching company name seen`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
