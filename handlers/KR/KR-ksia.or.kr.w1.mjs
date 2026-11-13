export const meta = {
  task: 'KR-ksia.or.kr',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_en', 'category', 'representative', 'phone', 'fax', 'website', 'detail_url'],
  canary: { found: '삼성전자㈜', not_found: '가나다반도체주식회사' },
};

// The member directory is one static page that lists every KSIA member (337 at the time of writing),
// grouped by industry. Each member has a detail box at ajax_member_c_info.php?idx=N.
const LIST_URL = 'https://www.ksia.or.kr/member_C.php?data_tab=2&sub_tab=1';
const DETAIL_BASE = 'https://www.ksia.or.kr/ajax/ajax_member_c_info.php?idx=';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko,en;q=0.8',
};

// Legal forms are dropped before comparing, so "Co., Ltd.", "(주)", "㈜", "주식회사" do not block a match.
const LEGAL_KO = /\(주\)|\(유\)|주식회사|유한회사|유한책임회사/g;
const LEGAL_EN = new Set(['co', 'ltd', 'limited', 'inc', 'corp', 'corporation', 'company', 'llc', 'pte', 'gmbh', 'plc']);

function normalize(s) {
  const t = String(s || '').normalize('NFKC').toLowerCase().replace(LEGAL_KO, ' ');
  return t.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !LEGAL_EN.has(w)).join('');
}

function cleanText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

// One entry per member: the list gives the idx, the Korean name (link text) and the full label
// "<Korean name> <English name>" (for example "삼성전자㈜ Samsung Electronics Co. Ltd - Device Solutions").
function parseList(html) {
  const re = /<div class="col-md-3 acc_content_sub ([^"]*)">\s*<h5>[\s\S]*?<a href="[^"]*ajax_member_c_info\.php\?idx=(\d+)"[^>]*>([^<]*)<\/a>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const label = m[1].trim();
    const kr = m[3].trim();
    const en = label.startsWith(kr) ? label.slice(kr.length).trim() : '';
    out.push({ idx: m[2], kr, en, label });
  }
  return out;
}

// Exact match on normalised names only. The English name is also tried without a division suffix
// ("Samsung Electronics Co. Ltd - Device Solutions" -> "Samsung Electronics Co. Ltd").
function candidateNames(r) {
  const set = new Set();
  const add = (x) => { const n = normalize(x); if (n) set.add(n); };
  add(r.kr);
  add(r.en);
  add(r.en.split(/\s+-\s+/)[0]);
  return set;
}

async function readDetail(m) {
  const url = DETAIL_BASE + m.idx;
  const base = { name: m.kr, name_en: m.en, detail_url: url };
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { ...base, detail_note: `not read: HTTP ${res.status}` };
    const html = await res.text();
    const f = {};
    for (const [, k, v] of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
      f[cleanText(k)] = cleanText(v);
    }
    return {
      name: f['업체명(국문)'] || m.kr,
      name_en: f['업체명(영문)'] || m.en,
      category: f['업체구분'] || '',
      representative: f['대표자'] || '',
      phone: f['전화번호'] || '',
      fax: f['팩스'] || '',
      website: f['웹사이트'] || '',
      detail_url: url,
    };
  } catch (err) {
    return { ...base, detail_note: `not read: ${String(err?.message || err).slice(0, 120)}` };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  if (!kwNorm) return fail('other', LIST_URL, 'empty company name');

  try {
    const res = await fetch(LIST_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return fail('blocked', LIST_URL, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', LIST_URL, `HTTP ${res.status}`);

    const html = await res.text();
    const list = parseList(html);
    if (list.length === 0) {
      return fail('layout_changed', LIST_URL, cleanText(html).slice(0, 300));
    }

    const matches = list.filter((r) => candidateNames(r).has(kwNorm));
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `KSIA member list (${list.length} members) has no member named "${kw}"`,
      };
    }

    const records = await Promise.all(matches.map(readDetail));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].detail_url,
      excerpt: `KSIA member directory: ${matches.map((m) => m.label).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', LIST_URL, String(err?.message || err).slice(0, 300));
  }
}
