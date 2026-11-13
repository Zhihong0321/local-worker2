export const meta = { task: 'PH-elibrary.judiciary.gov.ph', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'case', 'synopsis', 'hits', 'document_url'],
  canary: { found: 'San Miguel Corporation', not_found: 'Kumpanyang Walang Pangalan Corporation' } };

// Supreme Court E-Library full-text search (dtSearch). Same request the public /search page sends.
const SEARCH_URL = 'https://elibrary.judiciary.gov.ph/assets/dtSearch/dtSearch_system_files/dtisapi6.dll';
const INDEX = '*{81aab6aa66450ae68a1f722f505a17c7} sc_decision';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words: a typed name may use either spelling ("CORPORATION" or "CORP.").
const LEGAL = {
  corporation: ['corporation', 'corp'], corp: ['corporation', 'corp'],
  incorporated: ['incorporated', 'inc'], inc: ['incorporated', 'inc'],
  company: ['company', 'co'], co: ['company', 'co'],
  limited: ['limited', 'ltd'], ltd: ['limited', 'ltd'],
};
// Words that may follow a company name in a decision (party lists, "v.", "represented by", ...).
// Any other word right after the name means a different company ("SAN MIGUEL CORPORATION OFFICERS, INC.").
const STOP_AFTER = new Set(['and', 'v', 'vs', 'represented', 'petitioner', 'petitioners', 'respondent', 'respondents',
  'was', 'is', 'of', 'the', 'by', 'in', 'to', 'for', 'as', 'on', 'et', 'al', 'dba']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', Ntilde: 'Ñ', ntilde: 'ñ',
  Aacute: 'Á', aacute: 'á', Eacute: 'É', eacute: 'é', Iacute: 'Í', iacute: 'í',
  Oacute: 'Ó', oacute: 'ó', Uacute: 'Ú', uacute: 'ú', Uuml: 'Ü', uuml: 'ü' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([A-Za-z]+);/g, (m, n) => (NAMED[n] !== undefined ? NAMED[n] : m));
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return (String(s).match(/[\p{L}\p{N}]+/gu) || []).map((t) => t.toLowerCase());
}

/** The name as a case-insensitive pattern: same words, any punctuation/spacing between them, legal form either way. */
function namePattern(name) {
  const parts = tokens(name).map((t) => (LEGAL[t] ? '(?:' + LEGAL[t].join('|') + ')' : t));
  return new RegExp('(?<![\\p{L}\\p{N}])' + parts.join('[^\\p{L}\\p{N}]+') + '(?![\\p{L}\\p{N}])', 'giu');
}

/** First place in the snippet where the name occurs as a whole company name. Returns the text as the site writes it, or ''. */
function firstVerifiedMatch(text, pattern) {
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const nextWord = (after.match(/^\s*(\p{L}+)/u) || [])[1];
    const punctuationNext = /^\s*[^\p{L}\p{N}\s]/u.test(after);
    if (!nextWord || punctuationNext || STOP_AFTER.has(nextWord.toLowerCase())) return m[0];
  }
  return '';
}

/** The name without trailing legal-form words ("ACME TRADING CORP." -> "ACME TRADING"). */
function coreName(name) {
  const words = name.split(' ');
  while (words.length > 1 && LEGAL[(words[words.length - 1].match(/[\p{L}\p{N}]+/u) || [''])[0].toLowerCase()]) {
    words.pop();
  }
  return words.join(' ');
}

function searchUrl(request) {
  return SEARCH_URL + '?cmd=search&request=' + encodeURIComponent(request) + '&index=' + encodeURIComponent(INDEX) +
    '&searchType=phrase&pageSize=10&sort=Hits';
}

async function search(request) {
  const url = searchUrl(request);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://elibrary.judiciary.gov.ph/search/search_form',
    },
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  return { url, status: res.status, html };
}

/** Reads the hit count from a search page. Returns { total } or { bad, reason, excerpt }. */
function classify(r) {
  const m = r.html.match(/Search returned\s+(\d+)\s+result/i);
  if (m) return { total: Number(m[1]) };
  if (/was not found in any document/i.test(r.html)) return { total: 0 };
  if (r.status === 403 || r.status === 429) return { bad: 'blocked', reason: 'blocked', excerpt: 'HTTP ' + r.status };
  if (r.status >= 400) return { bad: 'http_error', reason: 'http_error', excerpt: 'HTTP ' + r.status };
  if (/captcha|access denied|log ?in required/i.test(r.html)) return { bad: 'blocked', reason: 'blocked', excerpt: cleanText(r.html).slice(0, 300) };
  return { bad: 'layout_changed', reason: 'layout_changed', excerpt: cleanText(r.html).slice(0, 300) };
}

function cc(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let source_url = '';
  try {
    const name = String(keyword || '').replace(/\s+/g, ' ').trim();
    if (!name) return cc('other', 'empty company name', '');

    const first = await search(name);
    source_url = first.url;
    let c = classify(first);
    if (c.bad) return cc(c.reason, c.excerpt, first.url);

    let used = first;
    let total = c.total;
    let query = name;

    // A name typed with a different legal form ("CORP." vs "CORPORATION") can miss the exact phrase: retry without it.
    if (total === 0 && coreName(name) !== name) {
      const core = coreName(name);
      const second = await search(core);
      c = classify(second);
      if (c.bad) return cc(c.reason, c.excerpt, second.url);
      used = second;
      total = c.total;
      query = core;
    }

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: used.url,
        excerpt: 'E-Library search for "' + query + '" returned 0 results' };
    }

    const pattern = namePattern(name);
    const blocks = used.html.split('<a class="file_link"').slice(1);
    const records = [];
    for (const b of blocks) {
      const href = (b.match(/href="([^"]+)"/) || [])[1] || '';
      const synopsisHtml = (b.match(/<p class="synopsis_hits">([\s\S]*?)<\/p>/) || [])[1] || '';
      const hits = Number((b.match(/No\. of hits:\s*<\/b>\s*(\d+)/i) || [])[1]) || 0;
      const synopsis = cleanText(synopsisHtml);
      const matched = firstVerifiedMatch(synopsis, pattern);
      if (!matched) continue;
      const caption = (synopsis.match(/\[\s*(G\.R\.[^\]]*?)\s*\]/) || [])[1] || '';
      records.push({ name: matched, case: caption, synopsis: synopsis.slice(0, 500), hits, document_url: decodeEntities(href) });
    }

    if (records.length === 0) {
      // Hits exist but none names this company. If every hit was on this page, they are all other companies.
      if (total <= blocks.length) {
        return { status: 'not_found', reason: '', records: [], source_url: used.url,
          excerpt: total + ' E-Library decisions mention "' + query + '", none names this company' };
      }
      return cc('other', total + ' hits for "' + query + '" but none of the first ' + blocks.length + ' shows the company name', used.url);
    }

    return { status: 'found', reason: '', records, source_url: used.url,
      excerpt: records.length + ' of the first ' + blocks.length + ' E-Library results (' + total + ' in total) name the company' };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timeout ? 'timeout' : 'other', String((err && err.message) || err).slice(0, 300), source_url);
  }
}
