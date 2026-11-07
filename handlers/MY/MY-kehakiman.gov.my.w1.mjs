// MY-kehakiman.gov.my — Pejabat Ketua Pendaftar Mahkamah Persekutuan Malaysia (the courts)
// Want w1: which published judgments name the company?
//
// The judiciary portal (www.kehakiman.gov.my) links its published judgments to the
// eJudgment portal. Its search page (EJudgmentWeb/SearchPage.aspx) is a JS shell that
// POSTs JSON to its own open web service, GetEJudgmentPortalSearchList, which answers
// with the matching judgments: case number and court, the parties by role, the date of
// decision, the judge or coram, the catchwords and the documents. No login, no token.
// Checked from a worker PC on 2026-11-07: Node's fetch gets the JSON (no bot check).

export const meta = {
  task: 'MY-kehakiman.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['case_no', 'court', 'parties', 'name_in_parties', 'date_of_decision', 'date_of_grounds', 'judge', 'summary', 'documents'],
  canary: { found: 'ZECON ENGINEERING & CONSTRUCTION SDN BHD', not_found: 'O2O Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;
const PAGE_URL = 'https://ejudgment.kehakiman.gov.my/EJudgmentWeb/SearchPage.aspx?JurisdictionType=ALL';
const API = 'https://ejudgment.kehakiman.gov.my/EJudgmentWeb/eJudgmentService.asmx/GetEJudgmentPortalSearchList';
const DOC = 'https://efs.kehakiman.gov.my/EFSWeb/DocDownloader.aspx?Inline=true&DocumentID=';
// 20 a page; three pages are the 60 most recent judgments.
const MAX_PAGES = 3;

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Letters and digits only, "Sdn. Bhd." and "Sendirian Berhad" alike. */
function squash(s) {
  return String(s)
    .toLowerCase()
    .replace(/\bsendirian\b/g, 'sdn')
    .replace(/\bberhad\b/g, 'bhd')
    .replace(/[^a-z0-9]/g, '');
}

/** "/Date(1767888000000)/" to a Malaysian calendar date. */
function day(value) {
  const m = /\/Date\((-?\d+)\)\//.exec(String(value || ''));
  if (!m) return '';
  return new Date(Number(m[1]) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** "<b>PERAYU</b><br />A<br />B<br /><br /><b>RESPONDEN</b><br />C" to [{ role, names }]. */
function parties(html) {
  const out = [];
  const re = /<b>([\s\S]*?)<\/b>([\s\S]*?)(?=<b>|$)/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const names = clean(m[2]).split('\n').map((n) => n.replace(/^\d+\s*\.?\s*\)\s*/, '').trim()).filter(Boolean);
    out.push({ role: clean(m[1]), names });
  }
  return out;
}

async function search(keyword, page) {
  const Param = {
    CourtCategory: null, Court: null, JurisdictionType: 'ALL',
    DateOfAPFrom: '', DateOfAPTo: '', DateOfResultFrom: '', DateOfResultTo: '',
    Search: keyword, JudgeName: '', CaseType: '', CurrPage: page, Ordering: 'DATE_OF_AP_DESC',
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'user-agent': UA, 'content-type': 'application/json; charset=utf-8', accept: 'application/json, text/javascript, */*',
      'x-requested-with': 'XMLHttpRequest', referer: PAGE_URL,
    },
    body: JSON.stringify({ Param }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status !== 200) return { error: 'http_error', detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  let data;
  try { data = JSON.parse(text).d; } catch { return { error: 'layout_changed', detail: 'the search service did not answer JSON' }; }
  if (!data || !Array.isArray(data.ListOfSearchItem) || typeof data.TOTAL_RECORD !== 'number') {
    return { error: 'layout_changed', detail: 'the answer has no ListOfSearchItem or TOTAL_RECORD' };
  }
  return { items: data.ListOfSearchItem, total: data.TOTAL_RECORD, pages: Number(data.TOTAL_PAGE) || 1 };
}

export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'empty keyword' };

  const items = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let r;
    try {
      r = await search(kw, page);
    } catch (e) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: PAGE_URL, excerpt: String(e && e.message).slice(0, 500) };
    }
    if (r.error) {
      return { status: 'couldnt_check', reason: r.error === 'layout_changed' ? 'layout_changed' : 'other', records: [], source_url: PAGE_URL, excerpt: r.detail.slice(0, 500) };
    }
    total = r.total;
    items.push(...r.items);
    if (page >= r.pages || !r.items.length) break;
  }

  const want = squash(kw);
  const records = items.map((it) => {
    const caseLines = clean(it.CaseNo).split('\n');
    const who = parties(it.Parties);
    const docs = (Array.isArray(it.ListOfAPDoc) ? it.ListOfAPDoc : [])
      .filter((d) => d && !d.IsExpunged && d.DocumentID)
      .map((d) => ({ name: clean(d.APDocName), by: clean(d.APPreparedBy), category: clean(d.DecisionCategory), url: DOC + encodeURIComponent(d.DocumentID) }));
    return {
      case_no: caseLines[0] || '',
      court: (caseLines[1] || '').replace(/^\(|\)$/g, ''),
      parties: who,
      // The site's search also matches the catchwords; this says whether the name is a party.
      name_in_parties: who.some((p) => p.names.some((n) => squash(n).includes(want))),
      date_of_decision: day(it.DateOfResult),
      date_of_grounds: day(it.DateOfAP),
      judge: clean(it.CorumJudge || it.Judge).replace(/\n/g, '; '),
      summary: clean(it.KeyWord).slice(0, 600),
      documents: docs,
    };
  });

  if (!records.length) {
    return {
      status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
      excerpt: `eJudgment portal search for "${kw}": 0 judgments.`,
    };
  }
  const r0 = records[0];
  const excerpt = (
    `${total} judgment(s) for "${kw}"${total > records.length ? `, the ${records.length} most recent here` : ''}; ` +
    `${records.filter((r) => r.name_in_parties).length} name it as a party. Latest: ${r0.case_no} (${r0.court}), ` +
    `decided ${r0.date_of_decision}: ${r0.parties.map((p) => `${p.role} ${p.names.join(', ')}`).join(' v ')}`
  ).replace(/\s+/g, ' ').slice(0, 500);
  return { status: 'found', reason: '', records, source_url: PAGE_URL, excerpt };
}
