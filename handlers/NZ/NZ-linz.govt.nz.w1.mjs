export const meta = {
  task: 'NZ-linz.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'case_number', 'decision_date', 'type', 'topic', 'decision', 'detail_url'],
  canary: { found: 'Oceana Gold (New Zealand) Limited', not_found: 'Tē Kōwhai Tūhono Limited' },
};

const BASE = 'https://www.linz.govt.nz';
const LIST_PATH = '/our-work/overseas-investment-regulation/decisions';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-NZ,en;q=0.9',
};
// Legal-form words dropped before comparing names and before the site's own search.
const LEGAL_FORMS = new Set(['limited', 'ltd', 'pty', 'pte', 'sdn', 'bhd', 'incorporated', 'inc', 'company', 'co',
  'llc', 'llp', 'lp', 'plc', 'gmbh', 'corp', 'corporation', 'pvt']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', rsquo: "'", lsquo: "'", ndash: '-', mdash: '-' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

function cleanText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function foldText(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
}

/** Normalised name: no case, punctuation, accents or legal-form words. */
function coreName(s) {
  return foldText(s).split(/[^a-z0-9]+/).filter((w) => w && !LEGAL_FORMS.has(w)).join('');
}

/** The keyword without legal-form words, used for the site's own search. The match is still strict. */
function searchTerm(keyword) {
  const words = String(keyword || '').trim().split(/\s+/)
    .filter((w) => !LEGAL_FORMS.has(foldText(w).replace(/[^a-z0-9]/g, '')));
  return words.join(' ').replace(/[,.;]+$/, '').trim() || String(keyword || '').trim();
}

/** Joint applicants are written with "and" or ";". The whole name, or one part of it, must match. */
function matchesKeyword(applicant, kwCore) {
  if (!kwCore) return false;
  if (coreName(applicant) === kwCore) return true;
  return String(applicant).split(/\s+and\s+|;/i).some((part) => coreName(part) === kwCore);
}

function looksBlocked(html) {
  return /captcha|access denied|are you a robot|cf-chl|attention required/i.test(html);
}

function isDecisionsPage(html) {
  return html.includes('views-exposed-form-oi-investment-releases-block-3');
}

function noResults(html) {
  return /can(?:'|&#0?39;|&#x27;|’)t find what you are looking for/i.test(html);
}

function parseRows(html) {
  const out = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    if (!tr.includes('views-field-field-oi-case-number')) continue;
    const caseCell = tr.match(/<td[^>]*views-field-field-oi-case-number[^>]*>([\s\S]*?)<\/td>/);
    const appCell = tr.match(/<td[^>]*views-field-field-oi-applicant[^>]*>([\s\S]*?)<\/td>/);
    const dateCell = tr.match(/<td[^>]*views-field-field-decision-date[^>]*>([\s\S]*?)<\/td>/);
    if (!caseCell || !appCell) continue;
    const link = caseCell[1].match(/href="([^"]+)"/);
    const time = dateCell ? dateCell[1].match(/<time[^>]*>([\s\S]*?)<\/time>/) : null;
    out.push({
      case_number: cleanText(caseCell[1]),
      applicant: cleanText(appCell[1]),
      decision_date: time ? cleanText(time[1]) : (dateCell ? cleanText(dateCell[1]) : ''),
      detail_url: link ? new URL(decodeEntities(link[1]), BASE).href : '',
    });
  }
  return out;
}

function parseDetail(html) {
  const text = cleanText(html);
  const type = (text.match(/\bType (.{1,60}?) Topic\b/) || [])[1] || '';
  const topic = (text.match(/\bTopic (.{1,80}?) Decision (?=\S)/) || [])[1] || '';
  const decision = (text.match(/\bTopic .{1,80}? Decision (.{3,250}?) Decision maker\b/) || [])[1] || '';
  return { type, topic, decision };
}

function couldnt(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/**
 * One search of the register by applicant name, with every result page (short pager, guarded by time).
 * Returns { url, html, rows, incomplete } or { fail } with the couldnt_check answer.
 */
async function searchOnce(term, elapsed) {
  const url = `${BASE}${LIST_PATH}?applicant=${encodeURIComponent(term)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  if (res.status === 403 || res.status === 429) return { fail: couldnt('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { fail: couldnt('http_error', url, `HTTP ${res.status}`) };
  const html = await res.text();
  if (!isDecisionsPage(html)) {
    return { fail: looksBlocked(html) ? couldnt('blocked', url, html.slice(0, 300)) : couldnt('layout_changed', url, html.slice(0, 300)) };
  }

  const rows = parseRows(html);
  const pageNums = [...html.matchAll(/href="[^"]*[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  const lastPage = Math.min(Math.max(0, ...pageNums), 3);
  let incomplete = false;
  for (let page = 1; page <= lastPage; page++) {
    if (elapsed() >= 10000) { incomplete = true; break; }
    const pageRes = await fetch(`${url}&page=${page}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (pageRes.status === 403 || pageRes.status === 429) return { fail: couldnt('blocked', url, `HTTP ${pageRes.status} on page ${page}`) };
    if (!pageRes.ok) return { fail: couldnt('http_error', url, `HTTP ${pageRes.status} on page ${page}`) };
    rows.push(...parseRows(await pageRes.text()));
  }
  return { url, html, rows, incomplete };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const kwCore = coreName(keyword);
  const full = searchTerm(keyword);
  // The site matches the typed text literally, so a punctuated name can miss. Second try: the first two words.
  const attempts = [full];
  const short = full.split(/\s+/).slice(0, 2).join(' ');
  if (short && short !== full) attempts.push(short);

  let firstUrl = `${BASE}${LIST_PATH}?applicant=${encodeURIComponent(full)}`;
  try {
    const seen = new Set();
    const unique = [];
    let matches = [];
    let matchUrl = '';
    let incomplete = false;
    let firstHtml = '';

    for (let i = 0; i < attempts.length; i++) {
      if (i > 0 && elapsed() >= 15000) { incomplete = true; break; }
      const r = await searchOnce(attempts[i], elapsed);
      if (r.fail) {
        if (matches.length === 0) return r.fail;
        break;
      }
      if (i === 0) { firstUrl = r.url; firstHtml = r.html; }
      if (r.incomplete) incomplete = true;
      for (const row of r.rows) {
        if (!seen.has(row.case_number)) { seen.add(row.case_number); unique.push(row); }
      }
      matches = unique.filter((row) => matchesKeyword(row.applicant, kwCore));
      if (matches.length) { matchUrl = r.url; break; }
    }

    if (unique.length === 0) {
      if (incomplete) return couldnt('timeout', firstUrl, 'time budget ran out before the search finished');
      if (noResults(firstHtml)) {
        return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
          excerpt: `The decisions register returned no decisions for "${full}".` };
      }
      return couldnt('layout_changed', firstUrl, 'no decision rows and no "no results" text');
    }

    if (matches.length === 0) {
      if (incomplete) return couldnt('timeout', firstUrl, 'time budget ran out before all result pages were read');
      const names = [...new Set(unique.map((row) => row.applicant))].slice(0, 5).join('; ');
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `${unique.length} decisions for "${full}" but none has this company name. Applicants seen: ${names}` };
    }

    // Detail pages add the type, topic and outcome. They are optional: the list already proves the match.
    const details = await Promise.all(matches.slice(0, 5).map(async (m) => {
      if (!m.detail_url || elapsed() > 25000) return {};
      try {
        const d = await fetch(m.detail_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        return d.ok ? parseDetail(await d.text()) : {};
      } catch {
        return {};
      }
    }));

    const records = matches.map((m, i) => ({
      name: m.applicant,
      case_number: m.case_number,
      decision_date: m.decision_date,
      type: details[i]?.type || '',
      topic: details[i]?.topic || '',
      decision: details[i]?.decision || '',
      detail_url: m.detail_url,
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matchUrl || firstUrl,
      excerpt: records.map((r) => `${r.case_number} | ${r.name} | ${r.decision_date} | ${r.decision}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, firstUrl, String(err?.message || err));
  }
}
