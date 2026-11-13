export const meta = { task: 'TH-fti.or.th', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'name_en', 'member_code', 'tax_id', 'member_type_code', 'website', 'provinces', 'industry_groups'],
  canary: { found: 'บริษัท กรีนก๊าซ ทรานสปอร์ต แอนด์ เอ็นจิเนียริ่ง จำกัด', not_found: 'บริษัท ซีโร่ ทดสอบไม่มีจริง จำกัด' } };

// Site: FTI member search (https://membersearch.fti.or.th). The page calls this JSON API with a plain GET, no login.
// The API matches the typed text against the Thai names (and some English names), so a name must be sent as written.
const API = 'https://membersearch.fti.or.th/api/search-new';
const PAGE = 'https://membersearch.fti.or.th/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIMIT = 50;
const BUDGET_MS = 30000; // stay well inside the 60 s limit for the whole call

const THAI_PREFIX = /^(ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|ห้างหุ้นส่วน|บริษัท)\s*/;
const THAI_SUFFIX = /\s*(\(มหาชน\)|มหาชน|จำกัด)\s*$/;
const EN_LEGAL = new Set(['co', 'company', 'ltd', 'limited', 'plc', 'pcl', 'public', 'inc', 'llc', 'llp', 'corp', 'corporation', 'sdn', 'bhd']);

const hasThai = (s) => /[฀-๿]/.test(s);
const hasLatin = (s) => /[A-Za-z]/.test(s);

/** Thai name without the prefix and legal-form suffix, e.g. "บริษัท X จำกัด" -> "X". */
function thaiCore(s) {
  let t = s.trim().replace(/\s+/g, ' ');
  let prev;
  do { prev = t; t = t.replace(THAI_PREFIX, '').replace(THAI_SUFFIX, '').trim(); } while (t !== prev);
  return t;
}

/** Comparison key for Thai names: no spaces or punctuation, lower case. Thai vowel marks are kept. */
function thaiKey(s) {
  return thaiCore(s).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** English name without trailing legal-form words, e.g. "Khumngern Khumtong Co., Ltd." -> "Khumngern Khumtong". */
function englishCore(s) {
  const words = s.replace(/[.,()]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length && EN_LEGAL.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

function englishKey(s) {
  return englishCore(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function clean(v) {
  return (v ?? '').toString().replace(/\s+/g, ' ').trim();
}

function toRecord(r) {
  return {
    name: clean(r.COMPANY_NAME),
    name_en: clean(r.COMP_PERSON_NAME_EN),
    member_code: clean(r.MEMBER_CODE),
    tax_id: clean(r.TAX_ID),
    member_type_code: clean(r.MEMBER_TYPE_CODE),
    website: clean(r.ADDR_WEBSITE),
    provinces: (r.PROVINCE_GROUPS || []).map((p) => clean(p.nameEn || p.nameTh)).filter(Boolean),
    industry_groups: (r.INDUSTRY_GROUPS || []).map((g) => clean(g.nameEn || g.nameTh)).filter(Boolean),
  };
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** One search request. Returns { ok: true, data } or { ok: false, reason, excerpt }. */
async function search(q) {
  const url = `${API}?q=${encodeURIComponent(q)}&limit=${LIMIT}&page=1&selectedFilter=all&exactMatch=0`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err) };
  }
  if (res.status === 403 || res.status === 429 || res.status === 401) {
    return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'layout_changed', excerpt: 'search answer is not JSON' };
  }
  if (!data || !Array.isArray(data.results) || !data.metadata || typeof data.metadata.total !== 'number') {
    return { ok: false, reason: 'layout_changed', excerpt: JSON.stringify(data).slice(0, 300) };
  }
  return { ok: true, data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const raw = clean(keyword);
    if (!raw) return couldnt('other', PAGE, 'empty company name');

    const pageUrl = `${PAGE}?q=${encodeURIComponent(raw)}`;

    // Queries to try, in order: the name as typed, the Thai core name, then for English names the core and its first word.
    const queries = [raw];
    if (hasThai(raw) && thaiCore(raw) !== raw) queries.push(thaiCore(raw));
    if (hasLatin(raw)) {
      const ec = englishCore(raw);
      if (ec) queries.push(ec);
      const first = ec.split(' ')[0];
      if (first && first.length >= 3) queries.push(first);
    }
    const tried = [...new Set(queries)];

    const wantThai = thaiKey(raw);
    const wantEn = englishKey(raw);
    const started = Date.now();
    let seen = 0;
    let truncated = false;

    for (const q of tried) {
      if (Date.now() - started > BUDGET_MS) {
        return couldnt('timeout', pageUrl, `stopped after ${BUDGET_MS / 1000} s with ${seen} results read`);
      }
      const r = await search(q);
      if (!r.ok) return couldnt(r.reason, pageUrl, r.excerpt);

      seen += r.data.results.length;
      if (r.data.metadata.totalPages > 1) truncated = true;

      const matches = r.data.results.filter((row) =>
        (wantThai && thaiKey(row.COMPANY_NAME || '') === wantThai) ||
        (wantEn && englishKey(row.COMP_PERSON_NAME_EN || '') === wantEn));

      if (matches.length) {
        const records = matches.map(toRecord);
        return {
          status: 'found',
          reason: '',
          records,
          source_url: pageUrl,
          excerpt: records.map((x) => `${x.name} | ${x.name_en} | tax ${x.tax_id}`).join(' ; ').slice(0, 300),
        };
      }
    }

    if (truncated) {
      return couldnt('other', pageUrl, `more than ${LIMIT} results for the name; the exact match could not be checked`);
    }
    if (!hasThai(raw)) {
      // The site's search does not reliably find English names (some listed companies return 0 results),
      // so an empty answer for an English-only name does not prove the company is not listed.
      return couldnt('other', pageUrl, `English-only name: the site search missed it, absence not proven (${seen} results read)`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: pageUrl,
      excerpt: `${seen} result(s) for the name, none with this company name`,
    };
  } catch (err) {
    return couldnt('other', PAGE, String(err?.message || err));
  }
}
