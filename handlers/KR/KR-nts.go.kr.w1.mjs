export const meta = {
  task: 'KR-nts.go.kr',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['no', 'year', 'name', 'representative', 'industry', 'company_address', 'representative_address',
    'total_arrears_krw_million', 'tax_type', 'due_date', 'arrears_count', 'arrears_summary'],
  canary: { found: 'Cido Car Carrier Service Ltd', not_found: '존재하지않는가상법인' },
};

// National Tax Service, "고액상습 체납자 명단" (corporate list, tcd=1). The search is a plain GET.
// The site matches the stored text case-sensitively and punctuation-sensitively, so the handler tries a few
// spellings of the name and then checks the normalised names itself.
const LIST_URL = 'https://www.nts.go.kr/nts/ad/openInfo/selectList.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;          // largest page the site offers
const MAX_PAGES = 5;            // at most 500 rows per spelling
const START_CUTOFF_MS = 30000;  // no new request after 30 s, so the whole call ends well under 60 s
const NO_DATA = '조회된 데이터가 없습니다';
const COLUMNS = ['no', 'year', 'name', 'representative', 'industry', 'company_address', 'representative_address',
  'total_arrears_krw_million', 'tax_type', 'due_date', 'arrears_count', 'arrears_summary'];
const LEGAL_EN = new Set(['ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'plc', 'sdn', 'bhd', 'berhad', 'pte', 'pvt', 'private', 'gmbh', 'kk', 'pty']);
const LEGAL_KR = ['주식회사', '유한책임회사', '유한회사', '합자회사', '합명회사', '(주)', '㈜', '(유)'];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

function clean(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cellText(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company name without legal-form words or punctuation; keeps the letter case. */
function coreName(s) {
  let t = clean(s);
  for (const w of LEGAL_KR) t = t.split(w).join(' ');
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_EN.has(w.toLowerCase()))
    .join(' ');
}

/** Comparison key: lower case, no spaces, no legal form. */
function keyOf(s) {
  return coreName(s).toLowerCase().replace(/\s+/g, '');
}

/** A register row matches when the typed name equals its name or one of the names in its brackets. */
function rowMatches(rowName, target) {
  const parts = [rowName, ...clean(rowName).split(/[()]/)];
  return parts.some((p) => keyOf(p) === target);
}

function titleCase(s) {
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Spellings to search for, most literal first. */
function spellingsOf(typed) {
  const core = coreName(typed);
  return [...new Set([clean(typed), core, titleCase(core), core.toUpperCase()].filter(Boolean))];
}

function listUrl(value, page) {
  return `${LIST_URL}?tcd=1&searchType=1&searchValue=${encodeURIComponent(value)}&pageIndex=${PAGE_SIZE}&currPage=${page}`;
}

function parseRows(html) {
  const rows = [];
  let layoutOk = true;
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    if (!tr.includes('data-table="number"')) continue;
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1]));
    if (cells.length !== COLUMNS.length) { layoutOk = false; continue; }
    const row = {};
    COLUMNS.forEach((f, i) => { row[f] = cells[i]; });
    rows.push(row);
  }
  return { rows, layoutOk };
}

/** One page of one spelling. Returns { ok: true, rows, total, url } or { ok: false, reason, url, excerpt }. */
async function fetchPage(value, page, deadline) {
  const url = listUrl(value, page);
  if (Date.now() > deadline) {
    return { ok: false, reason: 'timeout', url, excerpt: 'stopped before the 60 s limit' };
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko,en;q=0.8',
        'Referer': 'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=6685&cntntsId=8097',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: 'blocked', url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (html.includes(NO_DATA)) {
      return { ok: true, rows: [], total: 0, url };
    }
    const { rows, layoutOk } = parseRows(html);
    const totalMatch = html.match(/<strong>([\d,]+)<\/strong>\s*<strong class="pc_black">건/);
    if (!layoutOk || !html.includes('고액') || !rows.length || !totalMatch) {
      return { ok: false, reason: 'layout_changed', url, excerpt: html.slice(0, 300) };
    }
    return { ok: true, rows, total: Number(totalMatch[1].replace(/,/g, '')), url };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'other', url, excerpt: String(e).slice(0, 200) };
  }
}

/** All pages (up to MAX_PAGES) of one spelling. */
async function searchAll(value, deadline) {
  const first = await fetchPage(value, 1, deadline);
  if (!first.ok) return first;
  const pages = Math.ceil(first.total / PAGE_SIZE);
  let rows = first.rows;
  for (let p = 2; p <= Math.min(pages, MAX_PAGES); p++) {
    const next = await fetchPage(value, p, deadline);
    if (!next.ok) return next;
    rows = rows.concat(next.rows);
  }
  return { ok: true, rows, total: first.total, complete: pages <= MAX_PAGES, url: first.url };
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // Node on Windows aborts at process exit (libuv assertion, exit 127) while a keep-alive socket to this host is
  // still closing after two or more requests. A short settle lets it close first. Costs about 1 s.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return result;
}

async function lookupOnce(keyword) {
  const deadline = Date.now() + START_CUTOFF_MS;
  try {
    const typed = clean(keyword);
    const target = keyOf(typed);
    if (!target) return out('couldnt_check', 'other', [], '', 'no company name to search for');

    const spellings = spellingsOf(typed);
    let failure = null;
    let incomplete = null;
    for (const value of spellings) {
      const r = await searchAll(value, deadline);
      if (!r.ok) {
        failure = failure || r;
        continue;
      }
      const hits = r.rows.filter((row) => rowMatches(row.name, target));
      if (hits.length) {
        const h = hits[0];
        return out('found', '', hits, r.url,
          `${h.name} | ${h.representative} | ${h.company_address} | total arrears ${h.total_arrears_krw_million} (KRW million)`);
      }
      if (!r.complete) incomplete = incomplete || { value, total: r.total, shown: r.rows.length };
    }

    if (failure) return out('couldnt_check', failure.reason, [], failure.url, failure.excerpt);
    if (incomplete) {
      return out('couldnt_check', 'other', [], listUrl(incomplete.value, 1),
        `"${incomplete.value}" has ${incomplete.total} register rows; only the first ${incomplete.shown} were read`);
    }
    return out('not_found', '', [], listUrl(spellings[0], 1),
      `no corporate register row matches "${typed}" (searched: ${spellings.join(' | ')})`);
  } catch (e) {
    return out('couldnt_check', 'other', [], LIST_URL, 'handler error: ' + String(e).slice(0, 200));
  }
}
