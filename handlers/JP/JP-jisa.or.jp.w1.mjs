export const meta = { task: 'JP-jisa.or.jp', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'membership', 'section', 'website'],
  canary: { found: '(株)アークシステム', not_found: '株式会社存在しない情報システム' } };

const PAGE = 'https://www.jisa.or.jp/about_jisa/list/tabid/739/Default.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TABS = [
  { id: 1, label: '法人会員' },
  { id: 2, label: '団体会員' },
  { id: 3, label: '賛助会員' },
];

// Legal-form words removed on both sides before comparing (株式会社 / (株) / ㈱ / （株） etc.).
const LEGAL = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|\(株\)|\(有\)|\(同\)|\(合\)|\(一社\)|\(一財\)|\(公社\)|\(公財\)|\(社\)|\(財\)|\(特\)|\(医\)|\(学\)|\(独\)|\(NPO\)|\(npo\)|co\.?,?\s*ltd\.?|inc\.?|corp\.?|corporation|company|limited/gi;

function normalize(s) {
  return (s || '')
    .normalize('NFKC')          // full-width letters/digits, ㈱ -> (株), （）-> ()
    .toLowerCase()
    .replace(LEGAL, '')
    .replace(/[\s　.,・･\-‐－_'"＂’“”()（）]/g, '');
}

function cleanText(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Split the page into the three tab panels, then read every member link inside each panel. */
function parseTabs(html) {
  const out = {};
  for (const tab of TABS) {
    const start = html.indexOf(`id="Agg1768_TabPage${tab.id}"`);
    if (start < 0) return null;
    const nextMarker = TABS.map(t => html.indexOf(`id="Agg1768_TabPage${t.id}"`, start + 1)).filter(i => i > start);
    const end = nextMarker.length ? Math.min(...nextMarker) : html.length;
    const panel = html.slice(start, end);
    const entries = [];
    // A member cell is <td><a ... href="...">NAME</a></td>; a few cells have no opening <a> (stray </a> only).
    // Section-index links (href="#...") are skipped.
    const re = /<td>\s*(?:<a\b([^>]*)>)?([^<]+?)\s*(?:<\/a>)?\s*<\/td>/g;
    let m;
    while ((m = re.exec(panel)) !== null) {
      const attrs = m[1] || '';
      if (/href="#/.test(attrs)) continue;
      const name = cleanText(m[2]);
      if (!name) continue;
      const hrefMatch = attrs.match(/href=["']?([^"'\s>]+)/i);
      // Section letter: the nearest preceding <th colspan="2">X行</th> (or 社名頭文字 for index cells)
      const before = panel.slice(0, m.index);
      const secMatch = [...before.matchAll(/<th colspan="2">([^<]+)<\/th>/g)].pop();
      entries.push({
        name,
        website: hrefMatch ? hrefMatch[1] : '',
        section: secMatch ? cleanText(secMatch[1]) : '',
      });
    }
    out[tab.id] = entries;
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('Agg1768_TabPage1') || !html.includes('memberList') || !html.includes('JISA会員一覧')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: html.slice(0, 300) };
    }

    const tabs = parseTabs(html);
    const counts = tabs ? { main: tabs[1].length, group: tabs[2].length, supporting: tabs[3].length } : null;
    // Sanity floor: the main member list is about 450 companies. Far fewer means the page changed shape.
    if (!tabs || tabs[1].length < 100) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE,
               excerpt: `parsed ${JSON.stringify(counts)}` };
    }

    const kw = normalize(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'keyword is empty after normalising' };
    }

    const records = [];
    for (const tab of TABS) {
      for (const e of tabs[tab.id]) {
        if (normalize(e.name) === kw) {
          records.push({ name: e.name, membership: tab.label, section: e.section, website: e.website });
        }
      }
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: PAGE,
               excerpt: records.map(r => `${r.membership}: ${r.name}`).join(' | ').slice(0, 500) };
    }
    return { status: 'not_found', reason: '', records: [], source_url: PAGE,
             excerpt: `No match among ${counts.main} main, ${counts.group} group and ${counts.supporting} supporting members` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: PAGE,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
