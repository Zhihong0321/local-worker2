export const meta = { task: 'JP-jftc.go.jp', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'case_number', 'section', 'violation_law', 'action_date', 'list', 'description'],
  canary: { found: 'Google LLC', not_found: 'ゼノテストリレ株式会社' } };

// The JFTC publishes plain HTML tables (no search needed):
//  - /dk/ichiran/       独占禁止法 legal measures by year (cease-and-desist, commitments, ...)
//  - /toriteki/toritekikankoku/  Subcontract Act (取適法 / 下請法) recommendations by year
// The year pages are discovered from the two index pages, so newly linked years are picked up.
const BASE = 'https://www.jftc.go.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DK_INDEX = '/dk/ichiran/index.html';
const TORI_INDEX = '/toriteki/toritekikankoku/index.html';

const LEGAL_WORDS = new Set(['llc', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'company', 'co',
  'plc', 'gk', 'kk', 'gmbh', 'sdn', 'bhd']);

function clean(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

/** Compare form of a company name: width-folded, lower-case, no punctuation/spaces, no legal form. */
function normalise(name) {
  let s = (name || '').normalize('NFKC').toLowerCase();
  s = s.replace(/株式会社|有限会社|合同会社|合資会社|合名会社|相互会社/g, ' ');
  s = s.replace(/g\.\s*k\.?|k\.\s*k\.?/g, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s.split(' ').filter(w => w && !LEGAL_WORDS.has(w)).join('');
}

/** The 件名 cell is "<name>に対する件" (joint cases: "A及びBに対する件"). Returns the company names in it. */
function namesFromTitle(title) {
  const s = title.replace(/に対する.*$/, '').trim();
  return s.split(/及び|、/).map(x => x.trim()).filter(Boolean);
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
  const text = res.ok ? await res.text() : '';
  return { url, status: res.status, text };
}

function failReason(err, status) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (status === 403 || status === 429) return 'blocked';
  return 'http_error';
}

const LABELS = ['排除措置命令', '確約計画の認定', '課徴金納付命令', '勧告'];

/** Parse every table on one list page. Returns { rows: [...matches-ready records], rowCount, unparsed }. */
function parsePage(html, pageUrl, list) {
  const out = { entries: [], rowCount: 0, unparsed: 0 };
  let pos = 0;
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const at = html.indexOf(table, pos);
    pos = at + table.length;
    let section = '';
    let best = -1;
    for (const L of LABELS) {
      const p = html.lastIndexOf(L, at);
      if (p > best) { best = p; section = L; }
    }
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;
    const headers = (rows[0].match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(c => clean(c).replace(/\s+/g, ''));
    const col = (label) => headers.findIndex(h => h.includes(label));
    const iTitle = col('件名');
    const iCase = col('事件番号');
    const iLaw = col('違反法条');
    const iDesc = Math.max(col('内容'), col('概要'));
    const iDate = Math.max(col('措置年月日'), col('勧告年月日'));
    for (const r of rows.slice(1)) {
      const cells = (r.match(/<td[\s\S]*?<\/td>/gi) || []).map(c => clean(c));
      if (!cells.length) continue;
      out.rowCount++;
      if (iTitle < 0 || cells.length <= iTitle || !cells[iTitle]) { out.unparsed++; continue; }
      const title = cells[iTitle];
      for (const nm of namesFromTitle(title)) {
        out.entries.push({
          name: nm,
          title,
          record: {
            name: nm,
            case_number: iCase >= 0 ? cells[iCase] || '' : '',
            section,
            violation_law: iLaw >= 0 ? cells[iLaw] || '' : '',
            action_date: iDate >= 0 ? cells[iDate] || '' : '',
            list,
            description: iDesc >= 0 ? (cells[iDesc] || '').slice(0, 400) : '',
          },
          source_url: pageUrl,
        });
      }
    }
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const listIndex = BASE + DK_INDEX;
  try {
    const kw = normalise(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: listIndex, excerpt: 'company name is empty after normalising' };
    }

    // 1. Discover the year pages from the site's own index pages.
    const [dkIdx, toriIdx] = await Promise.all([get(BASE + DK_INDEX), get(BASE + TORI_INDEX)]);
    for (const [idx, marker, url] of [[dkIdx, '独占禁止法法的措置一覧', BASE + DK_INDEX], [toriIdx, '勧告一覧', BASE + TORI_INDEX]]) {
      if (idx.status !== 200) {
        return { status: 'couldnt_check', reason: failReason(null, idx.status), records: [], source_url: url, excerpt: `HTTP ${idx.status}` };
      }
      if (!idx.text.includes(marker)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: idx.text.slice(0, 200) };
      }
    }
    const linksIn = (html, prefix) => [...new Set([...html.matchAll(/href="(\/[^"#?]+\.html)"/g)].map(m => m[1]))]
      .filter(p => p.startsWith(prefix) && !p.endsWith('/index.html'));
    const dkPages = linksIn(dkIdx.text, '/dk/ichiran/').map(p => ({ path: p, list: 'legal measures' }));
    const toriPages = linksIn(toriIdx.text, '/toriteki/toritekikankoku/').map(p => ({ path: p, list: 'subcontract act' }));
    const pages = [...dkPages, ...toriPages];
    if (!dkPages.length || !toriPages.length) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: listIndex, excerpt: 'no year pages linked from the list index pages' };
    }

    // 2. Read every year page.
    const fetched = await Promise.all(pages.map(p => get(BASE + p.path).catch(err => ({ url: BASE + p.path, error: err }))));

    const matches = [];
    const failures = [];
    const layoutIssues = [];
    let rowCount = 0;
    let unparsed = 0;
    fetched.forEach((res, i) => {
      const page = pages[i];
      if (res.error || res.status !== 200) {
        failures.push({ url: res.url, reason: failReason(res.error, res.status), status: res.status });
        return;
      }
      if (!res.text.includes('公正取引委員会')) { layoutIssues.push(res.url); return; }
      const parsed = parsePage(res.text, res.url, page.list);
      rowCount += parsed.rowCount;
      unparsed += parsed.unparsed;
      if (parsed.rowCount > 0 && parsed.unparsed > 0 && parsed.entries.length === 0) layoutIssues.push(res.url);
      for (const e of parsed.entries) {
        if (normalise(e.name) === kw) matches.push(e);
      }
    });

    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches.map(m => m.record),
        source_url: first.source_url,
        excerpt: `${first.title} | ${first.record.section} | ${first.record.action_date}`.slice(0, 500),
      };
    }
    if (failures.length) {
      const f = failures[0];
      return {
        status: 'couldnt_check',
        reason: failures.some(x => x.reason === 'blocked') ? 'blocked' : failures[0].reason,
        records: [],
        source_url: f.url,
        excerpt: `${failures.length} of ${pages.length} list pages could not be read; first: HTTP ${f.status || 'error'}`,
      };
    }
    if (layoutIssues.length) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: layoutIssues[0] || listIndex, excerpt: 'list pages did not have the expected table' };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: listIndex,
      excerpt: `checked ${pages.length} list pages, ${rowCount} entries; no 件名 matches "${keyword}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other',
      records: [],
      source_url: listIndex,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
