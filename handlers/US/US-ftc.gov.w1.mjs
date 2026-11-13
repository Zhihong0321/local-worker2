export const meta = {
  task: 'US-ftc.gov',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'record_type', 'action_type', 'last_updated', 'matched_party'],
  canary: { found: 'Family Dollar Stores LLC', not_found: 'Blorvex Quantum Trading LLC' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.ftc.gov';
const MAX_PAGES = 5;          // at most 100 search results are read
const START_DEADLINE_MS = 30000; // no new page starts after 30 s (each fetch has its own 25 s timeout)
const LEGAL_WORDS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'lp', 'llp', 'plc', 'gmbh', 'sa', 'srl', 'pty', 'bv', 'nv', 'ag', 'kg', 'ltda']);

function decode(s) {
  return (s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case words of a name, with "&" read as "and" and punctuation removed. */
function words(str) {
  return cleanText(str).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean);
}

/** The name without its legal form ("Inc", "LLC", ...) at the end and without a leading "The". */
function coreName(str) {
  const w = words(str);
  if (w[0] === 'the') w.shift();
  while (w.length && LEGAL_WORDS.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** Party names a case title can refer to: the caption before ", FTC v." plus the parties after "In the Matter of". */
function candidateParties(title) {
  const s = decode(title).replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim();
  const head = s.replace(/,?\s*FTC\s+v\b.*$/i, '').replace(/,?\s*In the Matter of\b.*$/i, '');
  const after = (s.match(/In the Matter of\s+(.*)$/i) || [])[1] || '';
  const out = [];
  for (const part of [head, after]) {
    if (!part.trim()) continue;
    out.push(part);
    for (const piece of part.split(/;|\/| and /i)) out.push(piece);
  }
  return out.map((x) => x.trim()).filter(Boolean);
}

function searchUrl(phrase, page) {
  const q = encodeURIComponent(`"${phrase}"`);
  return `${BASE}/legal-library/search?search=${q}${page > 0 ? `&page=${page}` : ''}`;
}

function parseRows(html) {
  const rows = [];
  for (const chunk0 of html.split(/<article\b/i).slice(1)) {
    const chunk = chunk0.split(/<\/article>/i)[0];
    const about = (chunk.match(/^[^>]*\babout="([^"]+)"/i) || [])[1] || '';
    if (!about.startsWith('/legal-library/')) continue; // featured news items are not legal-library records
    const title = cleanText((chunk.match(/<h3[^>]*node-title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1]);
    if (!title) continue;
    rows.push({
      name: title,
      url: new URL(about, BASE).href,
      record_type: cleanText((chunk.match(/field--name-field-legal-library-record-types[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1]),
      action_type: cleanText((chunk.match(/field--name-field-case-action-type[\s\S]*?field__item">([\s\S]*?)<\/div>/i) || [])[1]),
      last_updated: ((chunk.match(/field--name-field-date[\s\S]*?<time[^>]*datetime="([^"]+)"/i) || [])[1]) || '',
    });
  }
  return rows;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const t0 = Date.now();
  // The site's phrase search does not match "and" ("Hims & Hers" needs "hims hers"), so it is left out of the query only.
  const phrase = coreName(keyword || '').split(' ').filter((w) => w && w !== 'and').join(' ');
  const firstUrl = searchUrl(phrase, 0);
  if (!phrase) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'no name words in the keyword' };
  }
  try {
    const matches = [];
    let total = null;   // results the site reports for the phrase
    let scanned = 0;    // results shown so far
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - t0 > START_DEADLINE_MS) break;
      const url = searchUrl(phrase, page);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        if (matches.length) break;
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        if (matches.length) break;
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
      }
      const html = await res.text();
      if (/access denied|captcha|are you a robot/i.test(html) && html.length < 20000) {
        if (matches.length) break;
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'bot or block page' };
      }

      const info = decode(html).match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
      if (/No results found for these filters/i.test(html)) {
        total = 0;
        break;
      }
      if (!info) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) };
      }
      total = Number(info[3]);
      scanned = Number(info[2]);

      const kw = coreName(keyword);
      for (const row of parseRows(html)) {
        const hit = candidateParties(row.name).find((p) => coreName(p) === kw && kw !== '');
        if (hit) matches.push({ ...row, matched_party: hit });
      }
      if (scanned >= total) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: matches.map((m) => `${m.name} (${m.record_type || 'record'}, ${m.last_updated || 'no date'})`).join(' | ').slice(0, 500),
      };
    }
    if (total === 0 || (total !== null && scanned >= total)) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `0 legal-library records match "${keyword}" (${total} results for "${phrase}")`,
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: firstUrl,
      excerpt: `read ${scanned} of ${total} results for "${phrase}"; no exact party-name match yet`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
