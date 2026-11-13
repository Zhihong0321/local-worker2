export const meta = {
  task: 'VN-tiki.vn',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'store_slug', 'seller_id', 'store_id', 'store_level', 'seller_type', 'is_official', 'status',
    'created_at', 'tax_name', 'tax_address', 'business_representative', 'url'],
  canary: { found: 'Nhà sách Fahasa', not_found: 'Công ty TNHH Thương mại Dịch vụ Bảo Lộc Không Tồn Tại' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const STORE_BASE = 'https://tiki.vn/cua-hang/';

// Legal-form words, compared after accents are removed. Removed on both sides before comparing names.
const LEGAL_WORDS = new Set(['cong', 'ty', 'tnhh', 'co', 'phan', 'cp', 'jsc', 'ltd', 'limited', 'pte', 'sdn', 'bhd',
  'inc', 'llc', 'corp', 'corporation', 'mtv', 'dntn', 'doanh', 'nghiep']);

function words(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
}

function stripLegal(s) {
  return words(s).filter((w) => !LEGAL_WORDS.has(w)).join(' ');
}

// Store addresses are built from the name: first the full name, then the name without legal-form words.
function candidateSlugs(name) {
  const full = words(name).join('-');
  const core = stripLegal(name).replace(/ /g, '-');
  return [...new Set([full, core])].filter(Boolean);
}

function sellerFrom(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { error: 'no __NEXT_DATA__ block on the store page' };
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return { error: 'store page JSON does not parse' }; }
  const st = data?.props?.initialState;
  const seller = st?.desktop?.sellerStore?.seller || st?.mobile?.sellerStore?.seller;
  return seller ? { seller } : { error: 'no seller block on the store page' };
}

function isTikiNotFound(html) {
  return html.includes('Không tìm thấy trang yêu cầu') || /404 Error/.test(html);
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  if (!stripLegal(name)) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no usable words in the company name' };
  }
  const tried = [];
  let lastUrl = '';
  let mismatch = '';
  try {
    for (const slug of candidateSlugs(name)) {
      const url = STORE_BASE + slug;
      lastUrl = url;
      tried.push(url);
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
      const html = await res.text();

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (res.status === 404) {
        if (!isTikiNotFound(html)) {
          return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'HTTP 404 without the Tiki not-found page' };
        }
        continue; // no store at this address; try the next candidate
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }

      const parsed = sellerFrom(html);
      if (parsed.error) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: parsed.error };
      }
      const s = parsed.seller;
      const storeName = String(s.store_name || s.seller_name || s.name || '').trim();
      if (stripLegal(storeName) !== stripLegal(name)) {
        mismatch = `store page ${url} shows "${storeName}", not "${name}"`;
        continue;
      }
      return {
        status: 'found',
        reason: '',
        records: [{
          name: storeName,
          store_slug: s.url_slug || slug,
          seller_id: s.seller_id ?? null,
          store_id: s.store_id ?? null,
          store_level: s.store_level || '',
          seller_type: s.seller_type || '',
          is_official: !!s.is_official,
          status: s.status ?? null,
          created_at: s.created_at || '',
          tax_name: s.tax_name || '', // masked by the site
          tax_address: s.tax_address_v2 || s.tax_address || '', // masked by the site
          business_representative: s.business_representative || '', // masked by the site
          url,
        }],
        source_url: url,
        excerpt: `Tiki store "${storeName}" (${s.store_level || 'store'}, status ${s.status ?? 'n/a'}); legal name shown only masked`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: mismatch || `No Tiki store page for this name at ${tried.join(', ')} (Tiki "not found" page, HTTP 404)`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: lastUrl || STORE_BASE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
