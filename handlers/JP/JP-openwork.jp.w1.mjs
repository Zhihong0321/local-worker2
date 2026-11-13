export const meta = { task: 'JP-openwork.jp', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'industry', 'address', 'employees', 'founded', 'capital', 'representative', 'fiscal_month', 'stock', 'listed_year', 'site_url', 'profile_url'],
  canary: { found: 'トヨタ自動車株式会社', not_found: 'ゼズネオ株式会社' } };

// OpenWork company search: GET /company_list?src_str=<name>. A hit is a list of company links (/company.php?m_id=...).
// A miss is served as HTTP 404 on /search/addcompany with the text 「<name>」に一致する企業は見つかりませんでした。
const BASE = 'https://www.openwork.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NO_MATCH = 'に一致する企業は見つかりませんでした';
const MAX_DETAIL = 3;
const LABELS = { '業界': 'industry', 'URL': 'site_url', '所在地': 'address', '社員数': 'employees', '設立年': 'founded',
  '資本金': 'capital', '代表者': 'representative', '決算月': 'fiscal_month', '株式情報': 'stock', '上場年': 'listed_year' };

function cleanText(html) {
  return (html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Comparable company name: full-width to half-width, no case, no legal form, no spaces or punctuation. */
function normalizeName(str) {
  return (str || '').normalize('NFKC').toLowerCase()
    .replace(/株式会社|有限会社|合同会社|合名会社|合資会社|相互会社|\(株\)|\(有\)|\(同\)/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function get(url) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
    signal: AbortSignal.timeout(25000) });
}

function result(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function failure(err, source_url) {
  const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return result('couldnt_check', timeout ? 'timeout' : 'other', source_url, timeout ? 'no answer within 25 s' : 'error: ' + String(err?.message || err));
}

/** company id -> set of link texts found on the search page (a company can have several links). */
function listEntries(html) {
  const entries = new Map();
  const re = /<a[^>]*href="\/company\.php\?m_id=([A-Za-z0-9]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = cleanText(m[2]);
    if (!text) continue;
    if (!entries.has(m[1])) entries.set(m[1], new Set());
    entries.get(m[1]).add(text);
  }
  return entries;
}

/** Profile page: the 企業情報 table is a list of <th label> <td value> rows. */
function parseProfile(html) {
  const rec = {};
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html))) {
    const key = LABELS[cleanText(m[1])];
    if (key && !(key in rec)) rec[key] = cleanText(m[2]);
  }
  return rec;
}

async function profileRecord(id, name) {
  const profile_url = `${BASE}/company.php?m_id=${id}`;
  const rec = { name, profile_url };
  try {
    const res = await get(profile_url);
    if (!res.ok) return { ...rec, detail_error: `profile HTTP ${res.status}` };
    const html = await res.text();
    return { ...rec, ...parseProfile(html) };
  } catch (err) {
    return { ...rec, detail_error: 'profile ' + (err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err)).slice(0, 120) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const q = String(keyword ?? '').trim();
  const source_url = `${BASE}/company_list?src_str=${encodeURIComponent(q)}&sort=1`;
  try {
    const kwNorm = normalizeName(q);
    if (!kwNorm) return result('couldnt_check', 'other', source_url, 'empty company name');

    const res = await get(source_url);
    if (res.status === 403 || res.status === 429) return result('couldnt_check', 'blocked', source_url, `HTTP ${res.status}`);

    const html = await res.text();
    const text = cleanText(html);

    if ((res.status === 200 || res.status === 404) && text.includes(NO_MATCH)) {
      return result('not_found', '', source_url, `HTTP ${res.status}: ${text.slice(text.indexOf(NO_MATCH) - 40, text.indexOf(NO_MATCH) + NO_MATCH.length)}`);
    }
    if (!res.ok) return result('couldnt_check', 'http_error', source_url, `HTTP ${res.status}`);

    const entries = listEntries(html);
    if (entries.size === 0) return result('couldnt_check', 'layout_changed', source_url, text.slice(0, 300));

    const hits = [];
    for (const [id, texts] of entries) {
      const hit = [...texts].find((t) => normalizeName(t) === kwNorm);
      if (hit) hits.push({ id, name: hit });
    }

    if (hits.length === 0) {
      // A full page (50 links) may hide the exact name on the next page, which this handler does not read.
      if (entries.size >= 50) return result('couldnt_check', 'other', source_url, `no exact match on the first page of results (${entries.size} shown)`);
      return result('not_found', '', source_url, `${entries.size} result(s), none matches the name`);
    }

    const records = await Promise.all(hits.slice(0, MAX_DETAIL).map((h) => profileRecord(h.id, h.name)));
    const first = records[0];
    const excerpt = `${first.name} | ${first.address || ''} | ${first.industry || ''}`;
    return result('found', '', source_url, excerpt, records);
  } catch (err) {
    return failure(err, source_url);
  }
}
