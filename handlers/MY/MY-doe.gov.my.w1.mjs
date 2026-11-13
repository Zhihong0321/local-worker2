export const meta = {
  task: 'MY-doe.gov.my',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['no', 'project_title', 'proponent', 'consultant', 'state', 'date', 'status', 'matched_as'],
  canary: { found: 'GSR Environmental Consultancy Sdn Bhd', not_found: 'Syarikat Tiada Rekod Sdn Bhd' },
};

// "Senarai EIA" on the DOE portal: one static table of EIA project records (2,120 rows at the time of writing).
// Each row names the project proponent (NAMA PENGGERAK PROJEK) and the EIA consultant (NAMA JURURUNDING EIA).
const LIST_URL = 'https://ekas.doe.gov.my/senarai-eia';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_ROWS = 100; // the full list is in the page; far fewer rows would mean the page was cut or paginated
const LEGAL_FORMS = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'plt', 'llp']);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => (parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : m))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, punctuation and legal form ignored ("ACME (M) Sdn. Bhd." == "Acme"). */
function normalize(name) {
  let s = decodeEntities(String(name || '')).toLowerCase();
  s = s.replace(/\(\s*m\s*\)/g, ' ').replace(/&/g, ' and ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s.split(' ').filter((t) => t && !LEGAL_FORMS.has(t)).join(' ');
}

function failure(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kwNorm = normalize(keyword);
    if (!kwNorm) return failure('other', LIST_URL, 'empty company name');

    let res;
    try {
      res = await fetch(LIST_URL, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return failure('timeout', LIST_URL, 'no answer in 25 s');
      return failure('other', LIST_URL, err && err.message);
    }

    if (res.status === 403 || res.status === 429) return failure('blocked', LIST_URL, `HTTP ${res.status}`);
    if (!res.ok) return failure('http_error', LIST_URL, `HTTP ${res.status}`);

    const html = await res.text();
    if (!/TAJUK LAPORAN EIA/i.test(html) || !/NAMA JURURUNDING EIA/i.test(html)) {
      return failure('layout_changed', LIST_URL, html.slice(0, 300));
    }

    // Each data row has 7 <td> cells: no, project title, proponent, consultant, state, date, status.
    const rows = [];
    for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
      if (cells.length >= 7 && /^\d+$/.test(cells[0])) rows.push(cells);
    }
    if (rows.length < MIN_ROWS) {
      return failure('layout_changed', LIST_URL, `only ${rows.length} EIA rows parsed`);
    }

    const records = [];
    for (const c of rows) {
      const proponentHit = normalize(c[2]) === kwNorm;
      const consultantHit = normalize(c[3]) === kwNorm;
      if (!proponentHit && !consultantHit) continue;
      records.push({
        no: c[0],
        project_title: c[1],
        proponent: c[2],
        consultant: c[3],
        state: c[4],
        date: c[5],
        status: c[6],
        matched_as: proponentHit && consultantHit ? 'proponent and consultant' : proponentHit ? 'proponent' : 'consultant',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `0 of ${rows.length} EIA records name "${keyword}" as proponent or consultant`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: LIST_URL,
      excerpt: `${records.length} EIA record(s) of ${rows.length}: ${records[0].project_title}`.slice(0, 500),
    };
  } catch (err) {
    return failure('other', LIST_URL, err && err.message);
  }
}
