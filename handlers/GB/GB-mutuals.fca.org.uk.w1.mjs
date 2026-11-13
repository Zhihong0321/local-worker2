export const meta = {
  task: 'GB-mutuals.fca.org.uk',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'society_id', 'registration_number', 'status', 'registered_as', 'registration_date', 'registration_act',
    'address', 'deregistration_date', 'deregistration_method'],
  canary: {
    found: '"Peace and Love" Arts Foundations Co-operative Limited',
    not_found: 'Zorbelle Hovington Fellowship Society Limited',
  },
};

const BASE = 'https://mutuals.fca.org.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const TOTAL_MS = 55000; // the whole call must finish in under 60 s
const REQ_MS = 25000;   // per fetch
const MAX_SEARCHES = 6;
const MAX_MATCHES = 3;

function decode(s) {
  return String(s || '')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode(String(html || '').replace(/\s*<br\s*\/?>\s*/gi, ', ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s*,(\s*,)*\s*/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

// Normalised name for comparing: lower case, no punctuation, no spaces, "&" read as "and".
function norm(s) {
  return decode(s).replace(/&/g, ' and ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The name without a trailing legal form (Limited / Ltd / PLC / LLP).
const LEGAL = /[\s,.;-]*\b(limited|ltd|plc|llp)\.?\s*$/i;
function coreName(name) {
  let t = String(name || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3 && LEGAL.test(t); i++) t = t.replace(LEGAL, '').trim();
  return t;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Search results page: "Search results returned: N", then one block per society.
function parseSearch(html) {
  const m = html.match(/Search results returned:\s*(\d+)/i);
  if (!m) return null;
  const entries = [];
  const re = /<a class="SearchLink" href="\/Search\/Society\/(\d+)">([\s\S]*?)<\/a>/g;
  let x;
  while ((x = re.exec(html))) {
    const end = html.indexOf('class="h4"', re.lastIndex);
    const block = html.slice(re.lastIndex, end > 0 ? end : re.lastIndex + 500);
    entries.push({
      id: x[1],
      name: cleanText(x[2]),
      status: lineValue(block, 'Status'),
      registration_number: lineValue(block, 'Registration Number'),
      address: lineValue(block, 'Address'),
    });
  }
  return { count: Number(m[1]), entries, more: /rel="next"/i.test(html) };
}

function lineValue(block, label) {
  const m = block.match(new RegExp('<div>\\s*' + escapeRe(label) + ':\\s*([^<]*)</div>', 'i'));
  return m ? cleanText(m[1]) : '';
}

// Society detail page: label / value rows in the Overview tab.
function labelValue(html, label) {
  const re = new RegExp('<label[^>]*>\\s*' + escapeRe(label) + '\\s*</label>\\s*<div[^>]*>([\\s\\S]*?)</div>', 'i');
  const m = html.match(re);
  return m ? cleanText(m[1]) : '';
}

function parseDetail(html) {
  const h1 = html.match(/<div><h1>([\s\S]*?)<\/h1><\/div>/i);
  const regNo = html.match(/Registration Number:\s*([^<]+?)\s*<\/strong>/i);
  if (!h1 || !/Registration Date|Registration Act/i.test(html)) return null;
  return {
    name: cleanText(h1[1]),
    registration_number: regNo ? cleanText(regNo[1]) : '',
    status: labelValue(html, 'Status'),
    registered_as: labelValue(html, 'Registration as'),
    registration_date: labelValue(html, 'Registration Date'),
    registration_act: labelValue(html, 'Registration Act'),
    address: labelValue(html, 'Address'),
    deregistration_date: labelValue(html, 'Deregistration Date'),
    deregistration_method: labelValue(html, 'Deregistration Method'),
  };
}

// One GET, bounded by the time left in the 60 s budget. Returns { text } or { fail, detail }.
async function fetchText(url, started) {
  const left = TOTAL_MS - (Date.now() - started);
  if (left < 3000) return { fail: 'timeout', detail: 'time budget used up before this request' };
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(Math.min(REQ_MS, left)) });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status}` };
    const text = await res.text();
    if (/captcha|cf-chl|checking your browser|are you a robot/i.test(text)) {
      return { fail: 'blocked', detail: 'bot check page' };
    }
    return { text };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: timedOut ? 'timeout' : 'other', detail: String((e && e.message) || e).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').replace(/\s+/g, ' ').trim();
  const searchUrl = (t) => `${BASE}/Search/Search?SearchTerm=${encodeURIComponent(t)}`;
  const fail = (reason, excerpt) => ({
    status: 'couldnt_check', reason, records: [], source_url: searchUrl(input), excerpt: String(excerpt).slice(0, 300),
  });

  try {
    if (!input) return fail('other', 'empty company name');
    const target = norm(coreName(input));
    if (!target) return fail('other', 'the name has no letters or digits to match');

    // The site's search only finds one unbroken piece of text. A listed name with quotes in the middle
    // ("Peace and Love" Arts ...) is not found by the plain name, so try the name without its legal form,
    // then the same name without its first word(s), while at least two words are left.
    const core = coreName(input);
    const terms = [input];
    if (core && core !== input) terms.push(core);
    const words = core.split(' ');
    for (let drop = 1; drop <= words.length - 2; drop++) terms.push(words.slice(drop).join(' '));
    const tried = [...new Set(terms)];
    const searches = tried.slice(0, MAX_SEARCHES);
    const skipped = tried.length > searches.length;

    const log = [];
    let uncertain = false;
    let matches = [];
    let matchedTerm = '';

    for (const t of searches) {
      const got = await fetchText(searchUrl(t), started);
      if (got.fail) return fail(got.fail, `search "${t}": ${got.detail}`);
      const page = parseSearch(got.text);
      if (!page) return fail('layout_changed', `search "${t}": no "Search results returned" line`);
      log.push(`"${t}" = ${page.count}`);
      const hits = page.entries.filter((e) => norm(coreName(e.name)) === target);
      if (hits.length) {
        matches = hits.slice(0, MAX_MATCHES);
        matchedTerm = t;
        break;
      }
      if (page.more) uncertain = true;
    }

    if (!matches.length) {
      if (uncertain) {
        return fail('other', `no exact match on the first results page; results run to more pages. ${log.join('; ')}`);
      }
      if (skipped) {
        return fail('other', `not all search variants could be run. ${log.join('; ')}`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl(input),
        excerpt: `Search results returned 0 exact matches for "${input}". ${log.join('; ')}`.slice(0, 300),
      };
    }

    // Read each matched society's own page for the rest of its record.
    const records = [];
    for (const hit of matches) {
      const url = `${BASE}/Search/Society/${hit.id}`;
      const got = await fetchText(url, started);
      const detail = got.text ? parseDetail(got.text) : null;
      const base = {
        name: hit.name,
        society_id: hit.id,
        registration_number: hit.registration_number,
        status: hit.status,
        registered_as: '',
        registration_date: '',
        registration_act: '',
        address: hit.address,
        deregistration_date: '',
        deregistration_method: '',
      };
      records.push({ ...base, ...(detail || {}), society_id: hit.id, source_url: url, detail_read: !!detail });
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].source_url,
      excerpt: `Matched "${matchedTerm}": ${records.map((r) => `${r.name} (${r.registration_number}, ${r.status})`).join('; ')}`.slice(0, 300),
    };
  } catch (err) {
    return fail('other', String((err && err.message) || err));
  }
}
