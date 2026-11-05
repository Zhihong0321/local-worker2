export const meta = {
  task: 'KR-alio.go.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'type', 'ministry', 'address', 'ceo', 'apba_id', 'disclosure_url'],
  canary: { found: '한국전력공사', not_found: '세무법인 혜움' },
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ENDPOINT = 'https://www.alio.go.kr/organ/findOrganApbaList.json';
const LIST_PAGE = 'https://www.alio.go.kr/guide/publicAgencyList.do';
const DETAIL = (id) => 'https://www.alio.go.kr/organ/organDisclosureDtl.do?apbaId=' + encodeURIComponent(id);
const CORP = /\(주\)|㈜|\(사\)|\(재\)|\(유\)|주식회사|사단법인|재단법인|유한회사|유한책임회사|합자회사|합명회사/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function politeFetch(url, init) {
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
}

function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(CORP, '')
    .replace(/[\s\-.,·・'"()\[\]{}]/g, '');
}

function cleanQuery(s) {
  return String(s || '')
    .replace(CORP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escBody(obj) {
  // The server decodes the request body as latin-1 before JSON parsing, so
  // non-ASCII characters must be sent as \uXXXX escapes.
  return JSON.stringify(obj).replace(/[^\x00-\x7f]/g, (c) => {
    const cp = c.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      return '\\u' + (0xd800 + (v >> 10)).toString(16) + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16);
    }
    return '\\u' + cp.toString(16).padStart(4, '0');
  });
}

async function searchPage(keyword, pageNo) {
  const res = await politeFetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'user-agent': UA,
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: LIST_PAGE,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: escBody({ apbaNa: keyword, pageNo }),
  });
  if (!res.ok) return { error: res.status === 403 || res.status === 429 ? 'blocked' : 'http_error', http: res.status };
  let json;
  try {
    json = await res.json();
  } catch {
    return { error: 'layout_changed' };
  }
  const list = json && json.data && json.data.organList;
  if (!json || json.status !== 'success' || !list || !Array.isArray(list.result) || !list.page) {
    return { error: 'layout_changed' };
  }
  return {
    records: list.result,
    totalCount: Number(list.page.totalCount) || 0,
    totalPage: Number(list.page.totalPage) || 0,
  };
}

export default async function lookup(keyword) {
  const name = String(keyword == null ? '' : keyword).trim();
  if (!name) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_PAGE, excerpt: 'empty company name' };
  }

  const tried = new Set();
  const queries = [];
  for (const q of [cleanQuery(name), cleanQuery(name).replace(/\s+/g, '')]) {
    if (q && !tried.has(q)) {
      tried.add(q);
      queries.push(q);
    }
  }
  if (!queries.length) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_PAGE, excerpt: 'no searchable name' };
  }

  const key = norm(name);
  const sourceUrl = ENDPOINT + ' (ALIO public agency list, POST apbaNa=' + queries[0] + ')';
  let sawAnyPage = false;
  let similar = [];

  try {
    for (const q of queries) {
      const first = await searchPage(q, 1);
      if (first.error) {
        return { status: 'couldnt_check', reason: first.error, records: [], source_url: sourceUrl, excerpt: '' };
      }
      sawAnyPage = true;
      const rows = [...first.records];
      const pages = Math.min(first.totalPage || 1, 5);
      for (let p = 2; p <= pages; p++) {
        const next = await searchPage(q, p);
        if (next.error) break;
        rows.push(...next.records);
      }
      const exact = rows.filter((r) => norm(r.apbaNa) === key);
      if (!exact.length && first.totalCount > rows.length) {
        // The name is too broad to enumerate completely: refuse to guess.
        return {
          status: 'couldnt_check',
          reason: 'other',
          records: [],
          source_url: sourceUrl,
          excerpt:
            'Search for "' + q + '" matched ' + first.totalCount + ' institutions (' + rows.length +
            ' inspected) without an exact name match; give the full legal institution name.',
        };
      }
      if (exact.length) {
        const records = exact.map((r) => ({
          name: r.apbaNa || '',
          type: r.typeNa || '',
          ministry: r.jidtNa || '',
          address: ((r.addrCd || '') + ' ' + (r.addr1 || '')).trim(),
          ceo: r.ceo || '',
          apba_id: r.apbaId || '',
          disclosure_url: r.apbaId ? DETAIL(r.apbaId) : '',
        }));
        const r0 = exact[0];
        const excerpt = records
          .map(
            (r) =>
              `기관명: ${r.name} | 기관유형: ${r.type} | 주무부처: ${r.ministry} | 소재지: ${r.address} | 대표자: ${r.ceo} | apbaId: ${r.apba_id}`,
          )
          .join('\n')
          .slice(0, 500);
        return {
          status: 'found',
          reason: '',
          records,
          source_url: r0.apbaId ? DETAIL(r0.apbaId) : sourceUrl,
          excerpt,
        };
      }
      // keep a few near matches only for the excerpt of a not_found answer
      if (!similar.length) similar = rows.map((r) => r.apbaNa).filter(Boolean).slice(0, 5);
      if (first.totalCount > 0) break; // results exist but no exact match: no need for the second query
    }

    if (!sawAnyPage) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: '' };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: similar.length
        ? 'API responded; no exact name match. Similar names returned: ' + similar.join(', ').slice(0, 400)
        : 'API responded with 0 institutions for the name (not a central public institution on ALIO).',
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const reason = /abort|timeout/i.test(msg) ? 'timeout' : 'http_error';
    return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: msg.slice(0, 200) };
  }
}
