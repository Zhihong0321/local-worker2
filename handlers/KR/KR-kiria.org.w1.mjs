// KIRIA (한국로봇산업진흥원) - robot certification records for one company.
// Two fixed public list pages are enough:
//   1) 실외이동로봇 운행안전인증 인증제품현황 (table: 인증번호 / 회사명 / 제품)
//   2) KS인증 인증제품현황 (product cards: 인증번호 / 제조자명 / 표준·모델)
// Plain GET, server-rendered HTML, no form, no cookie, no JS.

export const meta = {
  task: 'KR-kiria.org',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'cert_type', 'cert_no', 'product', 'date'],
  canary: { found: '뉴빌리티', not_found: '유진로봇' },
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const PAGES = [
  {
    url: 'http://www.kiria.org/portal/cert/portalCertEstiStats.do',
    certType: '실외이동로봇 운행안전인증',
    // markers that must still be on the page, else the layout changed
    markers: ['tbl-cert', '회사명', '운행 특이 사항'],
  },
  {
    url: 'http://www.kiria.org/portal/cert/portalCertEstiState.do',
    certType: 'KS인증',
    markers: ['인증제품현황', 'KS인증'],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// company-name normalisation: drop legal-form tokens, spaces and punctuation
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/주식회사|유한회사|합자회사|\(\s*주\s*\)|㈜|（주）/g, '')
    .replace(/[\s\u00a0\u3000·.,'"`()\[\]\-_/\\&+]/g, '')
    .toLowerCase();
}

function text(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cellText(html) {
  return text(html);
}

async function get(url) {
  const res = await fetch(url, {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const body = await res.arrayBuffer();
  // pages are utf-8; decode defensively for the unlikely case of euc-kr
  let decoder = new TextDecoder('utf-8', { fatal: false });
  let html = decoder.decode(body);
  if ((html.match(/\ufffd/g) || []).length > 20) {
    try {
      html = new TextDecoder('euc-kr', { fatal: false }).decode(body);
    } catch {}
  }
  return { status: res.status, url: res.url || url, html };
}

// ---- 실외이동로봇 운행안전인증: one <table>, one <tbody>, data rows ----
function parseOutdoor(html) {
  const tbodyStart = html.search(/<tbody[^>]*>/i);
  if (tbodyStart < 0) return { ok: false, rows: [] };
  let tbodyEnd = html.search(/<\/tbody>/i);
  if (tbodyEnd < tbodyStart) tbodyEnd = html.search(/<\/table>/i);
  if (tbodyEnd < tbodyStart) tbodyEnd = html.length;
  const tbody = html.slice(tbodyStart, tbodyEnd);
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(tbody)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(cellText(c[1]));
    if (cells.length < 5) continue;
    const company = cells[3];
    if (!company) continue;
    rows.push({
      name: company,
      cert_type: '실외이동로봇 운행안전인증',
      cert_no: cells[2] || '',
      date: cells[1] || '',
      product: [cells[4], cells[5], cells[6], cells[7]].filter(Boolean).join(' / '),
    });
  }
  return { ok: true, rows };
}

// ---- KS인증: product cards (<div class="bbs_pro_box ...">) with <dl><dt><dd> ----
function parseKs(html) {
  const blocks = html.split(/<div class="bbs_pro_box/gi).slice(1);
  if (blocks.length === 0) {
    // no cards -> either an empty list or a broken page; the caller checks markers
    return { ok: true, rows: [] };
  }
  const rows = [];
  for (const raw of blocks) {
    const block = raw.slice(0, raw.search(/<div class="bbs_pro_box/i) + 1 || raw.length);
    const dl = {};
    const dlRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    let m;
    while ((m = dlRe.exec(block)) !== null) {
      const k = text(m[1]).replace(/[:：]\s*$/, '').trim();
      const v = text(m[2]);
      if (k) dl[k] = v;
    }
    const company = dl['제조자명'] || '';
    if (!company) continue;
    const product = [dl['표준명'], dl['종류·등급 ·호칭 또는 모델'] || dl['종류·등급·호칭 또는 모델']]
      .filter(Boolean)
      .join(' / ');
    rows.push({
      name: company,
      cert_type: 'KS인증',
      cert_no: dl['인증번호'] || '',
      date: '',
      product,
    });
  }
  return { ok: true, rows };
}

/** Look one company up. Never throws. */
export default async function lookup(keyword) {
  const key = norm(keyword);
  if (!key) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty keyword' };
  }

  const records = [];
  const problems = [];
  let lastUrl = '';
  let excerpt = '';

  for (let i = 0; i < PAGES.length; i++) {
    const page = PAGES[i];
    if (i > 0) await sleep(1100); // be polite: <= 1 request / second
    let res;
    try {
      res = await get(page.url);
    } catch (e) {
      problems.push(`${page.certType}: fetch failed (${e && e.name ? e.name : 'error'})`);
      continue;
    }
    lastUrl = res.url;
    if (res.status !== 200) {
      problems.push(`${page.certType}: HTTP ${res.status}`);
      continue;
    }
    const missing = page.markers.filter((m) => !res.html.includes(m));
    if (missing.length) {
      problems.push(`${page.certType}: layout changed, missing markers ${missing.join(', ')}`);
      continue;
    }

    const parsed = page.certType === 'KS인증' ? parseKs(res.html) : parseOutdoor(res.html);
    if (!parsed.ok) {
      problems.push(`${page.certType}: layout changed, result table not found`);
      continue;
    }

    for (const r of parsed.rows) {
      const n = norm(r.name);
      if (!n) continue;
      if (n.includes(key) || (n.length >= 3 && key.includes(n))) {
        records.push(r);
        if (!excerpt) {
          const plain = text(res.html);
          const at = plain.indexOf(r.cert_no || r.name);
          excerpt = plain.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 420);
        }
      }
    }
  }

  if (records.length > 0) {
    return {
      status: 'found',
      reason: '',
      records: records.slice(0, 25),
      source_url: lastUrl || PAGES[0].url,
      excerpt: excerpt.slice(0, 500),
    };
  }

  if (problems.length === PAGES.length) {
    const layout = problems.every((p) => p.includes('layout changed'));
    return {
      status: 'couldnt_check',
      reason: layout ? 'layout_changed' : problems.some((p) => p.includes('HTTP')) ? 'http_error' : 'other',
      records: [],
      source_url: lastUrl || PAGES[0].url,
      excerpt: problems.join(' | ').slice(0, 500),
    };
  }

  // at least one list was read fine and the company is in none of them
  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl || PAGES[0].url,
    excerpt:
      'Checked KIRIA 인증제품현황 lists (실외이동로봇 운행안전인증, KS인증): no record naming this company.' +
      (problems.length ? ' (partial: ' + problems.join(' | ') + ')' : ''),
  };
}
