export const meta = {
  task: 'JP-tele.soumu.go.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'corporate_number', 'location', 'purpose', 'licence_date', 'station_type'],
  canary: { found: 'ソフトバンク株式会社', not_found: '株式会社ゼロゼロゼロ存在しない名前' },
};

// Expert search (免許情報) on the MIC radio portal: GET /musen/SearchServlet with the form fields.
// The licensee-name box is NA. The station-type box OW is required (an empty OW is rejected with a redirect page),
// and there is no "all types" option, so every station type is searched.
const BASE = 'https://www.tele.soumu.go.jp/musen/SearchServlet';
const ORIGIN = 'https://www.tele.soumu.go.jp/musen/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 500;
const MAX_PAGES = 3;
const BATCH = 6;
const DEADLINE_MS = 50000; // the whole call must finish in under 60 s
const FETCH_MS = 25000;

// Station-type values exactly as the OW select lists them, with their Japanese labels.
const STATION_TYPES = [
  ['AT 0', 'アマチュア局'], ['FB 0', '基地局(PHS除く)'], ['FB 2', '基地局(PHS)'], ['FP 0', '携帯基地局'],
  ['RP 0', '無線呼出局'], ['FBR0', '陸上移動中継局'], ['MS 0', '船舶局'], ['MSS0', '特定船舶局'],
  ['DS 0', '遭難自動通報局'], ['MB 0', '船上通信局'], ['FX 0', '固定局'], ['MA 0', '航空機局'],
  ['ML 0', '陸上移動局'], ['MP 0', '携帯局'], ['MO 0', '移動局'], ['RL 0', '無線航行陸上局'],
  ['RO 0', '無線航行移動局'], ['LR 0', '無線標定陸上局'], ['MR 0', '無線標定移動局'], ['RB 0', '無線標識局'],
  ['BB 0', '特定以外の地上基幹放送局'], ['TC 0', '地球局'], ['TI 0', '海岸地球局'], ['TB 0', '航空地球局'],
  ['TYP0', '携帯基地地球局'], ['TG 0', '船舶地球局'], ['TJ 0', '航空機地球局'], ['TUP0', '携帯移動地球局'],
  ['ME 0', '宇宙局'], ['EKT0', '人工衛星局'],
];

const REASON_PRIORITY = ['blocked', 'layout_changed', 'http_error', 'timeout', 'other'];

/** Compare names: full-width to half-width, case, legal form words and punctuation removed. */
function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)|\(合\)|\(資\)|\(名\)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildUrl(keyword, ow, page) {
  const sc = page === 1 ? 1 : (page - 1) * PAGE_SIZE + 1;
  const params = [
    ['SC', sc], ['pageID', 3], ['SelectID', 5], ['CONFIRM', page === 1 ? 0 : 1],
    ['FF', ''], ['TF', ''], ['NA', keyword], ['MA', ''], ['AS', ''],
    ['DFY', ''], ['DFM', ''], ['DFD', ''], ['DTY', ''], ['DTM', ''], ['DTD', ''],
    ['OW', ow], ['IT', ''], ['HC', ''], ['HV', ''], ['MK', ''], ['TSNJK', ''], ['KHS', ''],
    ['HZ', 2], ['FC', ''], ['DC', PAGE_SIZE],
  ];
  return BASE + '?' + params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}

function parseRows(html) {
  const out = [];
  for (const rm of html.matchAll(/<tr class="m-table-sort__row">([\s\S]*?)<\/tr>/g)) {
    const cells = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 4) continue;
    const nameCell = cells[0];
    const href = (nameCell.match(/href="([^"]+)"/) || [])[1] || '';
    const name = cleanText((nameCell.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const corp = (nameCell.match(/法人番号\s*(\d{13})/) || [])[1] || '';
    out.push({
      name,
      corporate_number: corp,
      location: cleanText(cells[1]),
      purpose: cleanText(cells[2]),
      licence_date: cleanText(cells[3]),
      detail_url: href ? new URL(href.replace(/&amp;/g, '&'), ORIGIN).href : '',
    });
  }
  return out;
}

/** Search one station type, reading every page of its result list. Never throws. */
async function searchCategory(keyword, ow, label, deadline) {
  const rows = [];
  let url = '';
  const fail = (reason, excerpt) => ({ ow, label, url, rows: [], error: { reason, excerpt: String(excerpt).slice(0, 300) } });
  for (let page = 1; page <= MAX_PAGES; page++) {
    url = buildUrl(keyword, ow, page);
    const remaining = deadline - Date.now();
    if (remaining < 3000) return fail('timeout', 'time budget used up before this station type finished');
    let res;
    let html;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
        signal: AbortSignal.timeout(Math.min(FETCH_MS, remaining)),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return fail(isTimeout ? 'timeout' : 'other', err?.message || err);
    }
    if (/captcha|Access Denied/i.test(html)) return fail('blocked', 'captcha or bot check on the result page');
    if (html.includes('検索結果が0件です')) return { ow, label, url, rows, error: null, total: 0 };
    const totalMatch = html.match(/全\s*([\d,]+)\s*件中/);
    if (!totalMatch) return fail('layout_changed', cleanText(html).slice(0, 300));
    const total = Number(totalMatch[1].replace(/,/g, ''));
    rows.push(...parseRows(html));
    if (page * PAGE_SIZE >= total) return { ow, label, url, rows, error: null, total };
  }
  return fail('other', 'more result pages than this handler reads');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const kwNorm = normalize(kw);
  const searchUrl = BASE + '?pageID=2&SelectID=5';
  if (!kwNorm) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
  }
  try {
    const started = Date.now();
    const deadline = started + DEADLINE_MS;
    const answered = [];
    const failed = [];
    const matches = [];

    for (let i = 0; i < STATION_TYPES.length; i += BATCH) {
      if (Date.now() >= deadline - 3000) break;
      const batch = STATION_TYPES.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(([ow, label]) => searchCategory(kw, ow, label, deadline)));
      for (const r of results) {
        if (r.error) { failed.push(r); continue; }
        answered.push(r);
        for (const row of r.rows) {
          if (normalize(row.name) === kwNorm) {
            matches.push({ ...row, station_type: r.label, _url: r.url });
          }
        }
      }
    }

    const notReached = STATION_TYPES.length - answered.length - failed.length;

    if (matches.length > 0) {
      const records = matches.map(({ _url, ...rest }) => rest);
      const typesWithHits = new Set(records.map((r) => r.station_type)).size;
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0]._url,
        excerpt: `${records.length} station records under "${records[0].name}" in ${typesWithHits} station types`,
      };
    }

    if (failed.length > 0 || notReached > 0) {
      const reasons = failed.map((f) => f.error.reason);
      const reason = REASON_PRIORITY.find((r) => reasons.includes(r)) || 'timeout';
      const first = failed[0] || { url: searchUrl, error: { excerpt: '' } };
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: first.url || searchUrl,
        excerpt: `${answered.length} of ${STATION_TYPES.length} station types answered, ${failed.length} failed, ${notReached} not reached. ${first.error.excerpt}`.slice(0, 300),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: answered[0]?.url || searchUrl,
      excerpt: `0 matching licence records in all ${STATION_TYPES.length} station types (検索結果が0件です)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
