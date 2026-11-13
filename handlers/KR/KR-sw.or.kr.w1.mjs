export const meta = {
  task: 'KR-sw.or.kr',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'representative', 'phone', 'founded', 'joined', 'member_type', 'billion_club', 'address', 'website', 'detail_url'],
  canary: { found: '주식회사 로이드케이', not_found: '주식회사 가나다라마바사아자차카타파하' },
};

// The public, name-searchable list on this site is the KOSA member directory (회원소개).
// Listed = a KOSA member company as shown on sw.or.kr. It is not the member-only SW business notification records.
const BASE = 'https://www.sw.or.kr';
const LIST_URL = BASE + '/site/sw/intro/memberListGallery.do';
const VIEW_URL = BASE + '/site/sw/intro/memberView.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.6',
};
const MAX_PAGES = 5;
const DEADLINE_MS = 40000;
const NO_DATA = '해당 자료가 없습니다';
const BLOCK_RE = /captcha|보안문자|자동입력방지|Access Denied|비정상적인 접근|접근이 차단/i;
const LABELS = {
  '대표이사': 'representative',
  '전화번호': 'phone',
  '설립일': 'founded',
  '회원가입일': 'joined',
  '회원구분': 'member_type',
  '천억클럽': 'billion_club',
};

/** Remove legal-form words (Korean and English) from a company name, keep the rest. */
function stripLegalForms(s) {
  return String(s || '').normalize('NFKC')
    .replace(/\(주\)|\(유\)|\(사\)|\(재\)|주식회사|유한책임회사|유한회사|합자회사|합명회사|사단법인|재단법인/g, ' ')
    .replace(/(?<![a-zA-Z])(co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|llc|pte\.?\s*ltd\.?|ltd\.?)(?![a-zA-Z])/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised comparison key: lower case, no legal form, no punctuation or spaces. */
function coreOf(s) {
  return stripLegalForms(s).toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

/** Name with every bracketed part removed, e.g. "주식회사 피드백(Feedback Co.,Ltd.)" -> "피드백". */
function withoutBrackets(s) {
  return String(s || '').replace(/\([^()]*\)/g, ' ');
}

/** Keys a listed name can be matched by: its full core, its core without brackets, and the core of each bracketed part. */
function candidatesOf(listedName) {
  const out = new Set();
  const full = coreOf(listedName);
  if (full.length >= 2) out.add(full);
  const bare = coreOf(withoutBrackets(listedName));
  if (bare.length >= 2) out.add(bare);
  const parts = String(listedName).match(/\(([^()]*)\)/g) || [];
  for (const p of parts) {
    const c = coreOf(p.slice(1, -1));
    if (c.length >= 2) out.add(c);
  }
  return out;
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Result list items: each has the view id, row number, company name and label/value lines. */
function parseList(html) {
  const items = [];
  const re = /<a href="javascript:fn_view\('(\d+)','(\d+)'\);?">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[3];
    const nm = block.match(/<b>\s*<em><\/em>([\s\S]*?)<\/b>/);
    if (!nm) continue;
    const item = { id: m[1], rn: m[2], name: cleanText(nm[1]), fields: {} };
    const lre = /<li>\s*<span>([^<]*?)\s*:\s*<\/span>([\s\S]*?)<\/li>/g;
    let l;
    while ((l = lre.exec(block)) !== null) {
      const label = cleanText(l[1]);
      if (LABELS[label] && !(LABELS[label] in item.fields)) item.fields[LABELS[label]] = cleanText(l[2]);
    }
    items.push(item);
  }
  return items;
}

/** Detail page: <th>label</th><td>value</td> rows. */
function parseDetail(html) {
  const out = {};
  const re = /<th>([^<]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const k = cleanText(m[1]);
    if (!(k in out)) out[k] = cleanText(m[2]);
  }
  return out;
}

/** Highest result-page number linked from the page (the last-page link). */
function maxPage(html) {
  let mx = 1;
  const re = /pageIndex=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) mx = Math.max(mx, parseInt(m[1], 10));
  return mx;
}

function get(url) {
  return fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) })
    .then(async (res) => ({ res, html: res.ok ? await res.text() : '' }));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  const name = String(keyword || '').trim();
  const core = coreOf(name);
  // The site search does not match across brackets or spaces inside a bracketed alias, so search the bare name.
  const bareSearch = stripLegalForms(withoutBrackets(name)).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const search = bareSearch.length >= 2 ? bareSearch : stripLegalForms(name).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = (p) => `${LIST_URL}?searchCondition=companyName&searchKeyword=${encodeURIComponent(search)}&pageIndex=${p}&gubun=G`;

  if (core.length < 2 || !search) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'name too short to search: ' + name };
  }

  try {
    let lastPage = 1;
    let scanned = 0;
    let matches = [];
    let listUrl = searchUrl(1);

    for (let p = 1; p <= MAX_PAGES; p++) {
      if (Date.now() - t0 > DEADLINE_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl(p), excerpt: `stopped before result page ${p} of ${lastPage}` };
      }
      const url = searchUrl(p);
      listUrl = url;
      const { res, html } = await get(url);

      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (/\/login/i.test(res.url || '')) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'redirected to login: ' + res.url };
      }

      if (p === 1) lastPage = maxPage(html);
      const items = parseList(html);

      if (items.length === 0) {
        if (html.includes(NO_DATA)) {
          scanned = p;
          break;
        }
        if (BLOCK_RE.test(html)) {
          return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: cleanText(html).slice(0, 200) };
        }
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: cleanText(html).slice(0, 300) };
      }

      scanned = p;
      matches = items.filter((it) => candidatesOf(it.name).has(core));
      if (matches.length > 0 || p >= lastPage) break;
    }

    if (matches.length === 0) {
      if (scanned < lastPage) {
        return {
          status: 'couldnt_check',
          reason: 'other',
          records: [],
          source_url: listUrl,
          excerpt: `no exact match on the first ${scanned} of ${lastPage} result pages for "${search}"; too many results to conclude`,
        };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl(1),
        excerpt: `0 matching entries in the KOSA member directory for "${search}" (${scanned} result page(s) checked)`,
      };
    }

    const records = [];
    for (const it of matches.slice(0, 3)) {
      const rec = {
        name: it.name,
        representative: it.fields.representative || '',
        phone: it.fields.phone || '',
        founded: it.fields.founded || '',
        joined: it.fields.joined || '',
        member_type: it.fields.member_type || '',
        billion_club: it.fields.billion_club || '',
        address: '',
        website: '',
        detail_url: '',
      };
      if (Date.now() - t0 < DEADLINE_MS) {
        try {
          const u = `${VIEW_URL}?bsnsNum=${it.id}&rn=${it.rn}`;
          const { res, html } = await get(u);
          if (res.ok && html) {
            const d = parseDetail(html);
            rec.address = d['주소'] || '';
            rec.website = d['홈페이지'] || '';
            if (d['회사명']) rec.name = d['회사명'];
            if (d['대표자명']) rec.representative = d['대표자명'];
            rec.detail_url = u;
          }
        } catch (_) {
          // keep the list data; the match itself is already proven by the list row
        }
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].detail_url || searchUrl(1),
      excerpt: `KOSA member directory: ${records.length} matching entr${records.length === 1 ? 'y' : 'ies'} for "${search}": ${records.map((r) => r.name).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: searchUrl(1),
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
