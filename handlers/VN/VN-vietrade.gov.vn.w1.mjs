export const meta = { task: 'VN-vietrade.gov.vn', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'name_en', 'address', 'phone', 'website', 'site_id', 'connective'],
  canary: { found: 'Công ty CP Eurowindow', not_found: 'Công ty TNHH Thương mại Hoàng Long Ảo' } };

// The site's enterprise page (vietrade.gov.vn/company, a list of featured enterprises) reads this JSON list.
// The list endpoint has no name-search parameter (the site sends only limit and offset), so the whole list is read
// and matched here.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LIST_URL = 'https://api.vietrade.gov.vn/v1/company?limit=500&offset=1';

// Legal-form and filler phrases removed from both sides before comparing (Vietnamese and English forms).
const LEGAL_PHRASES = [
  /\btong cong ty\b/g, /\bcong ty\b/g, /\btap doan\b/g, /\bjoint stock (commercial )?(company|corporation)\b/g,
  /\bjoint stock\b/g, /\bcompany limited\b/g, /\bco ltd\b/g, /\bltd\b/g, /\blimited\b/g, /\bcorporation\b/g,
  /\bcorp\b/g, /\bjsc\b/g, /\bcp\b/g, /\btnhh\b/g, /\bmtv\b/g, /\bco\b/g, /\bmot thanh vien\b/g, /\bone member\b/g,
  /\bgroup\b/g,
];

/** Lower-case, strip Vietnamese diacritics and punctuation, drop legal-form phrases, collapse spaces. */
function core(s) {
  let t = String(s || '').replace(/đ|Đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  for (const re of LEGAL_PHRASES) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: LIST_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = core(keyword);
    if (target.length < 3) return couldnt('other', 'company name too short to match: ' + String(keyword).slice(0, 100));

    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    let list;
    try { list = JSON.parse(text); } catch { return couldnt('layout_changed', 'not JSON: ' + text.slice(0, 200)); }
    if (!Array.isArray(list) || list.length === 0) return couldnt('layout_changed', 'list is not a non-empty array');

    const total = Number(res.headers.get('x-total-count'));
    if (Number.isFinite(total) && total > list.length) {
      return couldnt('other', `list incomplete: got ${list.length} of ${total} entries`);
    }

    const matches = list.filter((c) => {
      const vi = core(c.name_vi);
      const en = core(c.name_en);
      return (vi && vi === target) || (en && en === target);
    });

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: LIST_URL,
        excerpt: `Checked ${list.length} enterprises on the site list; none matches "${String(keyword).slice(0, 100)}"`,
      };
    }

    const records = matches.map((c) => ({
      name: c.name_vi || '',
      name_en: c.name_en || '',
      address: c.address || '',
      phone: c.phone || '',
      website: c.link || '',
      site_id: c.id,
      connective: c.connective === 1,
    }));
    return {
      status: 'found', reason: '', records, source_url: LIST_URL,
      excerpt: records.map((r) => `${r.name} / ${r.name_en}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
