export const meta = {
  task: 'IE-psi.ie',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'register', 'owner', 'address', 'registration_number', 'registration_date', 'expiry_date', 'phone', 'companies_office_number', 'details'],
  canary: { found: 'A.J. Hallahan Limited', not_found: 'Cuideachta Fhaiseanta Gaelach Teoranta' },
};

const BASE = 'https://registrations.thepsi.ie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_CAP = 40;          // max result pages read in one call
const DEADLINE_MS = 30000;    // stop starting new pages after this; one page fetch can take up to 25 s more, so stays under 60 s
const REGISTERS = [
  { key: 'pharmacy_register', path: '/search-register/', extra: { type: '0' } },
  { key: 'internet_supply_list', path: '/search-isl/', extra: {} },
];

// Legal-form words at the end of a company name, dropped before comparing names.
const LEGAL_SUFFIX = /( designated activity company| unlimited company| limited| ltd| dac| teoranta| teo| cuideachta theoranta| cuideachta| plc| clg| llc| inc| uc| company| co)$/;

function fold(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
}

/** Comparison key: letters and digits only, legal form removed. "A.J. Hallahan Limited" and "AJ Hallahan Ltd" give the same key. */
function nameKey(s) {
  let t = fold(s).split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  let prev;
  do { prev = t; t = t.replace(LEGAL_SUFFIX, ''); } while (t !== prev);
  return t.replace(/ /g, '');
}

/** Search text: the name without its legal form, as the user typed it. */
function coreText(keyword) {
  let t = (keyword || '').replace(/\s+/g, ' ').trim().replace(/[,;]+$/, '').trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/\s+(designated activity company|unlimited company|limited|ltd\.?|dac|teoranta|teo|cuideachta theoranta|cuideachta|plc|clg|llc|inc\.?|uc|company|co\.?)$/i, '').trim();
  } while (t !== prev && t);
  return t || (keyword || '').trim();
}

/** Second search term: the longest word of the name (at least 4 letters), for when punctuation stops the first one matching. */
function longestWord(core) {
  const words = core.split(/[\s,()&\/\-]+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(w => w.length >= 4);
  words.sort((a, b) => b.length - a.length);
  return words[0] || '';
}

function decode(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&#x27;|&apos;/gi, "'")
          .replace(/&quot;/gi, '"').replace(/&#32;/g, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cleanText(html) {
  return decode((html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** Parses one result page. Returns { total, cards } or throws a { reason } error. */
function parsePage(html, isPharmacy) {
  if (!html.includes('search-register-results')) throw { reason: 'layout_changed', excerpt: html.slice(0, 200) };
  let total = null;
  if (isPharmacy) {
    const m = html.match(/<span class="terms">\s*(\d+)\s*<\/span>\s*results? found/i);
    if (!m) throw { reason: 'layout_changed', excerpt: 'no "results found" line' };
    total = parseInt(m[1], 10);
  }
  const parts = html.split('search-register-result-item').slice(1);
  const cards = parts.map(part => {
    let chunk = part.split(/class="pagination|<!-- Pagination|<footer/i)[0];
    const name = cleanText((chunk.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i) || [])[1]);
    const address = cleanText((chunk.match(/<small[^>]*>([\s\S]*?)<\/small>/i) || [])[1]);
    const details = {};
    const paras = chunk.match(/<p class="srchlbls">[\s\S]*?<\/p>/g) || [];
    for (const p of paras) {
      const before = p.split('<span class="srchitms"')[0];
      const label = cleanText(before.split('</svg>').pop()).replace(/:\s*$/, '');
      const v = p.match(/<span class="srchitms"[^>]*>([\s\S]*?)<\/span>/);
      if (label) details[label] = v ? cleanText(v[1]) : '';
    }
    return { name, address, details };
  }).filter(c => c.name);
  return { total, cards, count: parts.length };
}

/** Labels that hold a company name (not a person, not a number). */
function companyNames(card) {
  const out = [card.name];
  for (const [label, value] of Object.entries(card.details)) {
    if (/owner|company name|trading name|business name|^name$/i.test(label) &&
        !/office|registration|number|superintendent|supervising|personnel|pharmacist|assistant/i.test(label)) {
      out.push(value);
    }
  }
  return out.filter(Boolean);
}

function pick(details, re) {
  for (const [label, value] of Object.entries(details)) if (re.test(label)) return value;
  return '';
}

function toRecord(register, card) {
  const d = card.details;
  return {
    register,
    name: card.name,
    owner: pick(d, /owner|company name/i),
    address: card.address,
    registration_number: pick(d, /registration number|^psi registration/i),
    registration_date: pick(d, /first registration|registration date/i),
    expiry_date: pick(d, /expiry/i),
    phone: pick(d, /^tel/i),
    companies_office_number: pick(d, /companies office/i),
    details: d,
  };
}

/** One GET of a register search, all its pages. Returns { ok, records, complete, url, excerpt } or a couldnt_check. */
async function searchRegister(reg, term, state) {
  const records = [];
  const firstUrl = buildUrl(reg, term, 1);
  let page = 1;
  let complete = false;
  let lastCount = 0;
  while (true) {
    if (state.pages >= PAGE_CAP || Date.now() - state.start > DEADLINE_MS) {
      return { status: 'couldnt_check', reason: 'other', records, source_url: firstUrl, excerpt: `search "${term}" in ${reg.key} is longer than the handler can read in one call (page ${page})` };
    }
    const url = buildUrl(reg, term, page);
    state.pages++;
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records, source_url: url, excerpt: String(e && e.message || e).slice(0, 200) };
    }
    if (res.status === 403 || res.status === 429) return { status: 'couldnt_check', reason: 'blocked', records, source_url: url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { status: 'couldnt_check', reason: 'http_error', records, source_url: url, excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    if (/captcha|cf-chl|Attention Required|Sign in to continue/i.test(html.slice(0, 20000)) && !html.includes('search-register-results')) {
      return { status: 'couldnt_check', reason: 'blocked', records, source_url: url, excerpt: 'bot check or login page' };
    }
    let parsed;
    try { parsed = parsePage(html, reg.key === 'pharmacy_register'); }
    catch (e) { return { status: 'couldnt_check', reason: e.reason || 'other', records, source_url: url, excerpt: String(e.excerpt || '').slice(0, 300) }; }

    for (const card of parsed.cards) {
      const key = nameKey(coreText(state.keyword));
      if (companyNames(card).some(n => nameKey(n) === key)) records.push(toRecord(reg.key, card));
    }
    state.lastExcerpt = state.lastExcerpt || html.match(/<div class="search-register-results">[\s\S]*?<\/p>/)?.[0] || '';
    lastCount = parsed.count;
    if (parsed.count === 0) { complete = true; break; }
    if (parsed.total !== null) {
      if (page * 9 >= parsed.total) { complete = true; break; }
    } else if (!html.includes(`page=${page + 1}`)) { complete = true; break; }
    page++;
  }
  return { status: complete ? 'done' : 'couldnt_check', reason: complete ? '' : 'other', records, source_url: firstUrl, excerpt: '', lastCount };
}

function buildUrl(reg, term, page) {
  const u = new URL(BASE + reg.path);
  for (const [k, v] of Object.entries(reg.extra)) u.searchParams.set(k, v);
  if (page > 1) u.searchParams.set('page', String(page));
  u.searchParams.set('search', `*${term}*`);
  return u.href;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const state = { keyword: String(keyword || ''), start: Date.now(), pages: 0, lastExcerpt: '' };
  try {
    const core = coreText(state.keyword);
    const terms = [core];
    const second = longestWord(core);
    if (second && second.toLowerCase() !== core.toLowerCase()) terms.push(second);
    if (!core || !nameKey(core)) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE + '/search-register/', excerpt: 'empty company name' };
    }

    const found = [];
    let firstUrl = '';
    let incomplete = null;
    for (const term of terms) {
      for (const reg of REGISTERS) {
        const r = await searchRegister(reg, term, state);
        if (!firstUrl) firstUrl = r.source_url;
        found.push(...r.records);
        if (r.status !== 'done' && !incomplete) incomplete = r;
      }
    }

    // De-duplicate the same record found by two search terms.
    const seen = new Set();
    const records = found.filter(r => { const k = r.register + '|' + r.name + '|' + r.address; if (seen.has(k)) return false; seen.add(k); return true; });

    if (records.length) {
      return {
        status: 'found', reason: '', records,
        source_url: records[0].register === 'pharmacy_register' ? buildUrl(REGISTERS[0], terms[0], 1) : buildUrl(REGISTERS[1], terms[0], 1),
        excerpt: records.map(r => `${r.name} | ${r.owner} | ${r.registration_number}`).join(' || ').slice(0, 500),
      };
    }
    if (incomplete) {
      return { status: 'couldnt_check', reason: incomplete.reason, records: [], source_url: incomplete.source_url, excerpt: incomplete.excerpt };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: firstUrl,
      excerpt: (state.lastExcerpt || 'no matching entry on either register').slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check', reason: 'other', records: [],
      source_url: BASE + '/search-register/',
      excerpt: String(err && err.message || err).slice(0, 300),
    };
  }
}
