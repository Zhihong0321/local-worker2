export const meta = {
  task: 'FR-h2a-france.org',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'list', 'legal_form', 'seat', 'registration_number', 'first_registration_year', 'phone', 'website', 'crcc', 'sustainability_certified'],
  canary: { found: '01 ACCOUNTING SERVICES', not_found: 'SOCIETE FANTOME ZZQXV SARL' },
};

// The two H2A lists of French audit firms (personnes morales). Each firm is one <div class="card"> with its name in <h4>.
const LISTS = [
  { url: 'https://h2a-france.org/liste/liste-I-SECTION-2.html', label: 'Liste I section 2 (personnes morales, commissaires aux comptes)' },
  { url: 'https://h2a-france.org/liste/liste-V.html', label: 'Liste V (organismes tiers independants)' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words are dropped before comparing names, so "ACME SARL" and "ACME" are the same company.
const LEGAL_FORMS = new Set(['SARL', 'SAS', 'SASU', 'EURL', 'SA', 'SELARL', 'SELAFA', 'SELAS', 'SCP', 'SCM', 'SCI', 'SNC', 'SCS', 'SEL', 'SE', 'EI', 'SC']);

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', eacute: 'e', egrave: 'e', ecirc: 'e', agrave: 'a', ccedil: 'c', ocirc: 'o', ucirc: 'u', ugrave: 'u', iuml: 'i', euml: 'e' };

function chr(cp) {
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => chr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => chr(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (_, n) => NAMED_ENTITIES[n.toLowerCase()] ?? ' ');
}

function stripTags(html) {
  return decode(html.replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/(\s*\|\s*)+/g, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .trim();
}

function cellsOf(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...html.matchAll(re)].map((m) => stripTags(m[1]));
}

function normName(s) {
  const tokens = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !LEGAL_FORMS.has(t));
  return tokens.join('');
}

function fieldKey(header) {
  const h = header.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (h.startsWith('forme')) return 'legal_form';
  if (h.startsWith('siege')) return 'seat';
  if (h.startsWith('n') && h.includes('inscription') && !h.includes('premiere')) return 'registration_number';
  if (h.includes('premiere inscription') || h.startsWith('annee')) return 'first_registration_year';
  if (h.startsWith('telephone')) return 'phone';
  if (h.startsWith('site')) return 'website';
  if (h.startsWith('crcc')) return 'crcc';
  if (h.includes('durabilite')) return 'sustainability_certified';
  return null;
}

// One firm card: its name, then a table with a header row and the first data row.
function cardRecord(name, table, list) {
  const headers = cellsOf(table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)?.[1] || '', 'th');
  const tbody = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || '';
  const firstRow = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1] || '';
  const values = cellsOf(firstRow, 'td');
  const rec = { name: stripTags(name), list: list.label };
  headers.forEach((h, i) => {
    const key = fieldKey(h);
    if (key) rec[key] = values[i] || '';
  });
  return rec;
}

// The whole call must end before 60 s. Both lists share this one deadline.
// The main list is about 22.7 MB as text but only about 2.3 MB on the wire (gzip). Its firms are in the same order
// every time, so a match can appear early. The list is read as a stream, and the read stops as soon as a matching
// card is complete. Only a "not found" needs the whole list.
const DEADLINE_MS = 50000;
const MIN_NEW_ATTEMPT_MS = 5000;
const MAX_ATTEMPTS = 3;

function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function stopped(list, reason, excerpt) {
  return { url: list.url, complete: false, matches: [], cards: 0, reason, excerpt };
}

// One streamed GET of one list. Returns { url, complete, matches, cards, reason, excerpt }:
//  - matches.length > 0: a card with the same normalised name (read up to that card; the rest is not needed)
//  - complete: the whole list was read and every card was checked, with no match
//  - otherwise: couldnt_check with a reason (never "not found")
async function scanOnce(list, key, deadlineAt) {
  const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate',
  };

  let res;
  try {
    res = await fetch(list.url, { headers, signal });
  } catch (err) {
    return stopped(list, isTimeout(err) ? 'timeout' : 'other', String(err?.message || err).slice(0, 120));
  }
  if (res.status === 403 || res.status === 429) return stopped(list, 'blocked', `HTTP ${res.status}`);
  if (res.status !== 200) return stopped(list, 'http_error', `HTTP ${res.status}`);

  const dec = new TextDecoder('utf-8');
  const cardRe = /<h4 class="card-title[^"]*">([\s\S]*?)<\/h4>\s*<\/div>\s*<div class="card-body">\s*<table class="table">([\s\S]*?)<\/table>/g;
  let text = '';
  let scannedTo = 0; // everything before this index has been checked; only complete cards are matched
  let cards = 0;
  const matches = [];
  let bytes = 0;

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      text += dec.decode(value, { stream: true });
      cardRe.lastIndex = scannedTo;
      let m;
      while ((m = cardRe.exec(text)) !== null) {
        scannedTo = cardRe.lastIndex;
        cards++;
        const rec = cardRecord(m[1], m[2], list);
        if (normName(rec.name) === key) matches.push(rec);
      }
      if (matches.length) break;
    }
  } catch (err) {
    return stopped(list, isTimeout(err) ? 'timeout' : 'other', `${String(err?.message || err).slice(0, 120)} (${(bytes / 1e6).toFixed(1)} MB read)`);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (matches.length) return { url: list.url, complete: false, matches, cards, reason: '', excerpt: '' };

  text += dec.decode();
  if (!text.includes('card-title')) {
    if (/cf-chl|Just a moment|captcha/i.test(text.slice(0, 20000))) return stopped(list, 'blocked', 'bot check page');
    return stopped(list, 'layout_changed', text.slice(0, 300));
  }
  const headings = (text.match(/<h4 class="card-title/g) || []).length;
  if (cards === 0 || cards !== headings) {
    return stopped(list, 'layout_changed', `parsed ${cards} of ${headings} firm cards`);
  }
  return { url: list.url, complete: true, matches: [], cards, reason: '', excerpt: '' };
}

// Retries only while there is time left; a block or a changed layout is not retried.
async function scanList(list, key, deadlineAt) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && deadlineAt - Date.now() < MIN_NEW_ATTEMPT_MS) break;
    last = await scanOnce(list, key, deadlineAt);
    if (last.complete || last.matches.length) return last;
    if (['blocked', 'http_error', 'layout_changed'].includes(last.reason)) return last;
  }
  return last || stopped(list, 'timeout', 'no attempt made before the deadline');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normName(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LISTS[0].url, excerpt: 'empty company name' };
    }

    const deadlineAt = Date.now() + DEADLINE_MS;
    const results = await Promise.all(LISTS.map((list) => scanList(list, key, deadlineAt)));

    const records = results.flatMap((r) => r.matches);
    if (records.length) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: results.find((r) => r.matches.length).url,
        excerpt: `${first.name} | ${first.legal_form || ''} | ${first.seat || ''} | n ${first.registration_number || ''} | ${first.list}`.slice(0, 500),
      };
    }

    const failed = results.filter((r) => !r.complete);
    if (failed.length) {
      const f = failed[0];
      const okCount = results.length - failed.length;
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.url,
        excerpt: `${f.excerpt} (${okCount} of ${LISTS.length} lists read, no match in them)`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LISTS[0].url,
      excerpt: results.map((r) => `${r.cards} firms read from ${r.url}`).join('; ') + ': no name match',
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LISTS[0].url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
