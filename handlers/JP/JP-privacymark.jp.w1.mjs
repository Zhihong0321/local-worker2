// JIPDEC PrivacyMark Registry (プライバシーマーク付与事業者検索) - company lookup handler.
// privacymark.jp links to the registry search at https://entity-search.jipdec.or.jp/pmark/. That page is a
// JavaScript app; its results come from the public, unauthenticated JSON list API it calls in the browser:
//   https://jipdec-pmark.g.kuroco.app/rcms-api/5/pmark?filter=<expr>&cnt=<n>[&pageID=<p>]
// Filter used by the site for a name search: jigyosya_mei contains "<text>". Text is matched width-sensitively
// (the registry stores full-width letters, e.g. 株式会社Ａ), so the handler also tries the other width forms.

export const meta = {
  task: 'JP-privacymark.jp',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_number', 'branch_number', 'prefecture', 'address', 'industry_code',
    'certified_date', 'expiry_start', 'expiry_end', 'review_body', 'cancel_date'],
  canary: { found: 'アイ社会保険労務士法人', not_found: '存在しない架空商事株式会社' },
};

const API = 'https://jipdec-pmark.g.kuroco.app/rcms-api/5/pmark';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE_SIZE = 500;   // the API returns every match of a page of this size in one response
const MAX_PAGES = 10;    // at most 5,000 rows per query; beyond that the check is reported as incomplete
const BUDGET_MS = 45000; // the whole call must finish in under 60 s

// Legal-form words that the registry writes in company names (removed before comparing names).
const LEGAL_FORMS = ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '相互会社', '一般社団法人', '一般財団法人',
  '公益社団法人', '公益財団法人', '社会福祉法人', '特定非営利活動法人', '医療法人', '学校法人', '宗教法人',
  '独立行政法人', '地方独立行政法人', '協同組合', '組合', '法人'];
const LEGAL_ASCII = /(?<![a-z])(?:co\.?,?\s*)?(?:ltd|limited|inc|corp|corporation|llc|pte|sdn\s*bhd|bhd|pvt|co)\.?(?![a-z])/g;

/** Comparison key: width, case, punctuation, spaces and legal form ignored. */
function normalise(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  t = t.replace(/[（(]\s*(株|有|合|資|名)\s*[）)]/g, '');
  for (const f of LEGAL_FORMS) t = t.split(f).join('');
  t = t.replace(LEGAL_ASCII, '');
  return t.replace(/[^\p{L}\p{N}]/gu, '');
}

/** The keyword without legal-form words, spaces collapsed. */
function core(s) {
  let t = String(s || '').replace(/㈱/g, '株式会社').replace(/[（(]\s*(株|有|合|資|名)\s*[）)]/g, '');
  for (const f of LEGAL_FORMS) t = t.split(f).join('');
  return t.replace(/\s+/g, ' ').trim();
}

function toFullWidthAlnum(s) {
  return s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
}

function toHalfWidthAlnum(s) {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/** Filter texts to query: the keyword and its core, each as typed and in the other ASCII width. */
function buildTexts(keyword) {
  const bases = [...new Set([String(keyword).trim().replace(/\s+/g, ' '), core(keyword)].filter(Boolean))];
  const texts = [];
  for (const b of bases) {
    for (const v of [b, toFullWidthAlnum(b), toHalfWidthAlnum(b)]) {
      if (v && !texts.includes(v) && !v.includes('"')) texts.push(v);
    }
  }
  return texts;
}

class Fail {
  constructor(reason, excerpt, url) {
    this.reason = reason;
    this.excerpt = excerpt;
    this.url = url;
  }
}

function listUrl(text, pageNo) {
  const parts = [
    `filter=${encodeURIComponent(`jigyosya_mei contains "${text}"`)}`,
    `cnt=${PAGE_SIZE}`,
  ];
  if (pageNo > 1) parts.push(`pageID=${pageNo}`);
  return `${API}?${parts.join('&')}`;
}

async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Fail('timeout', 'no answer within 25 s', url);
    throw new Fail('other', String(e?.message || e).slice(0, 200), url);
  }
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Fail('layout_changed', text.slice(0, 200), url);
  }
  if (!data || !Array.isArray(data.list) || !data.pageInfo || typeof data.pageInfo.totalCnt !== 'number') {
    throw new Fail('layout_changed', text.slice(0, 200), url);
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Fail('other', `API error: ${JSON.stringify(data.errors).slice(0, 200)}`, url);
  }
  return data;
}

/** All rows of one filter text, page by page. `truncated` is true when some rows could not be read. */
async function collect(text, started) {
  const rows = [];
  let total = 0;
  let firstUrl = '';
  for (let p = 1; p <= MAX_PAGES; p++) {
    if (Date.now() - started > BUDGET_MS) throw new Fail('timeout', 'the search did not finish within 45 s', firstUrl);
    const url = listUrl(text, p);
    if (!firstUrl) firstUrl = url;
    const data = await fetchPage(url);
    total = data.pageInfo.totalCnt;
    rows.push(...data.list);
    if (data.list.length === 0 || rows.length >= total) break;
  }
  return { rows, total, truncated: rows.length < total, url: firstUrl };
}

function toRecord(row) {
  return {
    name: row.jigyosya_mei || '',
    registration_number: row.toroku_bango || '',
    branch_number: row.toroku_bango_edaban == null ? '' : String(row.toroku_bango_edaban),
    prefecture: row.todofuken_mei || '',
    address: row.honsha_jusho || '',
    industry_code: row.gyoshu_code == null ? '' : String(row.gyoshu_code),
    certified_date: row.fuyo_tekikaku_ketteibi || '',
    expiry_start: row.yukokigen_kaishibi || '',
    expiry_end: row.yukokigen_manryobi || '',
    review_body: row.shinsa_kikan || '',
    cancel_date: row.cancel_date || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = `${API}?${new URLSearchParams({ filter: `jigyosya_mei contains "${String(keyword).trim()}"` }).toString()}`;
  try {
    const key = normalise(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
               excerpt: 'no company name left after removing legal form, spaces and punctuation' };
    }

    const texts = buildTexts(keyword);
    const matches = new Map();
    let incomplete = false;
    let urlSet = false;
    for (const text of texts) {
      const r = await collect(text, started);
      if (!urlSet && r.url) { firstUrl = r.url; urlSet = true; }
      for (const row of r.rows) {
        if (normalise(row.jigyosya_mei) === key) {
          const id = `${row.toroku_bango}-${row.toroku_bango_edaban}`;
          if (!matches.has(id)) matches.set(id, toRecord(row));
        }
      }
      if (r.truncated) incomplete = true;
    }

    if (matches.size > 0) {
      const records = [...matches.values()];
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${first.name} ${first.registration_number}-${first.branch_number}, expiry ${first.expiry_end}`.slice(0, 500),
      };
    }

    if (incomplete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
               excerpt: `too many partial matches to read every row (more than ${MAX_PAGES * PAGE_SIZE}); not_found cannot be proven` };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 registry rows match "${String(keyword).trim()}" (queries: ${texts.join(' | ')})`,
    };
  } catch (err) {
    if (err instanceof Fail) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url || firstUrl, excerpt: err.excerpt };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
