export const meta = {
  task: 'JP-jetro.go.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company', 'country', 'area', 'company_type', 'field', 'technology', 'intro', 'date', 'url'],
  canary: { found: '株式会社SY Partners', not_found: '株式会社存在しない企業検証テスト' },
};

const PAGE_URL = 'https://www.jetro.go.jp/j-bridge/companies/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words removed before comparing names (both sides go through the same rule).
const LEGAL_WORDS = new Set([
  'inc', 'incorporated', 'co', 'company', 'corporation', 'corp', 'ltd', 'limited', 'llc', 'llp', 'plc',
  'gmbh', 'ag', 'bv', 'srl', 'sl', 'sa', 'spa', 'ab', 'aps', 'as', 'oy', 'sas', 'sarl', 'nv', 'ltda', 'pt',
  'pty', 'pvt', 'private', 'pte', 'sdn', 'bhd', 'jsc', 'joint', 'stock', 'kk', 'kabushiki', 'kaisha',
]);
const LEGAL_JA = /株式会社|有限会社|合同会社|合名会社|合資会社/g;

function normName(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase().replace(LEGAL_JA, ' ');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join('');
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normName(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
        excerpt: 'the name has no letters or digits left after removing the legal form' };
    }

    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const block = html.match(/<script[^>]*id="jbridgeJsonData"[^>]*>([\s\S]*?)<\/script>/i);
    if (!block) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: html.slice(0, 300) };
    }
    let data;
    try {
      data = JSON.parse(block[1]);
    } catch (e) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: 'embedded JSON did not parse' };
    }
    const items = Array.isArray(data?.content) ? data.content : null;
    if (!items) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: 'no content list in the embedded JSON' };
    }

    const records = [];
    for (const it of items) {
      const names = [it.title, it.jdx_company].filter(Boolean);
      if (names.some((n) => normName(n) === key)) {
        records.push({
          name: cleanText(it.title),
          company: cleanText(it.jdx_company),
          country: cleanText(it.common_country),
          area: cleanText(it.common_area),
          company_type: cleanText(it.jdx_company_type),
          field: cleanText(it.jdx_field),
          technology: cleanText(it.jdx_techonology),
          intro: cleanText(it.jdx_intro),
          date: cleanText(it.date),
          url: new URL(it.url, 'https://www.jetro.go.jp').href,
        });
      }
    }

    if (records.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
        excerpt: `0 of ${items.length} companies on the J-Bridge list match "${keyword}"` };
    }
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].url,
      excerpt: `${records.length} match(es) of ${items.length} companies on the J-Bridge list: ${records[0].intro}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
