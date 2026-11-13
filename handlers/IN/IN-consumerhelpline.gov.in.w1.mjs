export const meta = { task: 'IN-consumerhelpline.gov.in', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['brand_name', 'legal_name', 'matched_on'],
  canary: { found: 'Royal Enfield', not_found: 'शून्य उद्यम प्राइवेट लिमिटेड' } };

// Public page: "Convergence Partners" of the National Consumer Helpline. One static HTML table, every row in the page.
const PAGE = 'https://consumerhelpline.gov.in/public/convergencepartners';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_WORDS = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'company', 'co', 'opc', 'sdn', 'bhd', 'inc', 'plc']);

function decode(s) {
  return s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: lower case, punctuation and spaces removed, trailing legal-form words removed. */
function nameKey(str) {
  const words = String(str || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  while (words.length && LEGAL_WORDS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function parseRows(html) {
  const start = html.indexOf('<tbody');
  const end = start < 0 ? -1 : html.indexOf('</tbody>', start);
  if (start < 0 || end < 0) return null;
  const rows = html.slice(start, end).match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const r of rows) {
    const cells = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(cleanText);
    if (cells.length >= 2 && (cells[0] || cells[1])) out.push({ brand: cells[0], legal: cells[1] });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '');
  try {
    const key = nameKey(kw);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'the name has no letters or digits to compare' };
    }

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
    const rows = parseRows(html);
    if (!html.includes('partnersTable') || !rows || rows.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: html.slice(0, 300) };
    }

    const records = [];
    for (const row of rows) {
      const legalNoBrackets = row.legal.replace(/\([^)]*\)/g, ' ');
      const innerBrackets = [...row.legal.matchAll(/\(([^)]*)\)/g)].map(m => m[1]);
      const brandHit = nameKey(row.brand) === key;
      const legalHit = [row.legal, legalNoBrackets, ...innerBrackets].some(c => nameKey(c) === key);
      if (brandHit || legalHit) {
        records.push({ brand_name: row.brand, legal_name: row.legal, matched_on: brandHit ? 'brand_name' : 'legal_name' });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: PAGE,
        excerpt: `No Convergence Partner on the public list (${rows.length} rows) has a brand or legal name matching "${kw}".`,
      };
    }
    return {
      status: 'found', reason: '', records, source_url: PAGE,
      excerpt: records.map(r => `${r.brand_name} | ${r.legal_name}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PAGE,
      excerpt: String(err && err.message ? err.message : err).slice(0, 300),
    };
  }
}
