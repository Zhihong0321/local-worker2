export const meta = {
  task: 'GB-architects-register.org.uk',
  want: 'w1',
  tier: 2,
  method: 'post',
  input: 'company name',
  fields: ['name', 'architect', 'registration_number', 'address', 'country', 'detail_url'],
  canary: { found: 'Foster + Partners', not_found: 'Zzqxw Nonexistent Architects Ltd' },
};

// The register's own search: POST /registrant/list with a JSON body (the same call the home page makes).
// It is a "contains" match on the practice (company) name and returns HTML, 5 architects per page.
const SITE = 'https://architects-register.org.uk';
const LIST_URL = SITE + '/registrant/list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 5;
const BATCH = 4;           // pages requested at a time
const BUDGET_MS = 40000;   // no new pages after 40 s, so the whole call ends well inside 60 s
const MAX_RECORDS = 100;
const LEGAL_FORMS = ['limited', 'ltd', 'llp', 'plc', 'llc', 'inc', 'lp'];

// The same filter list the home page sends. Only CompanyName gets a value.
const FILTER_DEFS = [
  { column: 'RegistrationNumber', display: 'Registration number', type: 'text', wildcard: false },
  { column: 'ArchitectForename', display: 'Forename', type: 'text', wildcard: false },
  { column: 'ArchitectSurname', display: 'Surname', type: 'text', wildcard: false },
  { column: 'CompanyName', display: 'Company name', type: 'text', wildcard: false },
  { column: 'Address', display: 'Address (contains)', type: 'text', wildcard: true },
  { column: 'Country', display: 'Country', type: 'select', wildcard: true },
  { column: 'Website', display: 'Website', type: 'text', wildcard: false },
  { column: 'Email', display: 'Email', type: 'text', wildcard: false },
  { column: 'Geography', display: 'Distance from UK postcode', type: 'radius', wildcard: false },
];

function filtersFor(name) {
  return FILTER_DEFS.map((f) => ({
    IndexFilterId: 'Architect', Column: f.column, Display: f.display, AdditionalText: null, AllowMultiple: null,
    Type: f.type, WildcardStart: f.wildcard, WildcardEnd: f.wildcard, SoundsLike: false, SoundsLikeEnabled: false,
    SoundsLikeDefault: false, SelectItems: null, Value: f.column === 'CompanyName' ? name : null,
  }));
}

function decode(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "Foster + Partners Ltd" -> "Foster + Partners": a trailing legal form is removed. */
function coreName(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const m = t.match(/^(.*?)[\s,.]+([A-Za-z.]+)$/);
    if (!m || !LEGAL_FORMS.includes(m[2].replace(/\./g, '').toLowerCase())) break;
    t = m[1].trim();
  }
  return t.replace(/[\s,.]+$/, '').trim();
}

/** Case, punctuation and legal form ignored; "and" and "&" are not treated as the same word. */
function nameKey(s) {
  return coreName(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function countOf(html) {
  const m = html.match(/Architect \((\d+) Results?\)/);
  return m ? Number(m[1]) : null;
}

function parseRecords(html) {
  const out = [];
  for (const li of html.match(/<li class="media[\s\S]*?<\/li>/g) || []) {
    const strong = li.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    const nameLine = cleanText(strong ? strong[1] : '');
    const nm = nameLine.match(/^(.*?)\s*\(([^()]+)\)$/);
    const parts = ((li.split('</strong>')[1] || '').split('</div>')[0])
      .split(/<br\s*\/?>/i).map(cleanText).filter(Boolean);
    const href = li.match(/href="(\/Architect\/[^"]+)"/);
    out.push({
      name: parts[0] || '',
      architect: nm ? nm[1].trim() : nameLine,
      registration_number: nm ? nm[2].trim() : '',
      address: parts[1] || '',
      country: parts[2] || '',
      detail_url: href ? new URL(href[1], SITE).href : '',
    });
  }
  return out;
}

async function fetchPage(name, page) {
  try {
    const res = await fetch(LIST_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html, */*; q=0.01',
        'Referer': SITE + '/',
      },
      body: JSON.stringify({ filters: filtersFor(name), sorting: '', bounds: null, indexFilterId: 'Architect', page }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    if (/captcha|challenge-platform|just a moment/i.test(html)) return { fail: 'blocked', detail: 'bot check page' };
    return { html };
  } catch (err) {
    const timed = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: timed ? 'timeout' : 'other', detail: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const searchName = coreName(keyword);
  const wanted = nameKey(searchName);
  const source_url = SITE + '/';
  const cu = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) });

  try {
    if (!wanted) return cu('other', 'the name is empty once the legal form is removed');

    const first = await fetchPage(searchName, 0);
    if (first.fail) return cu(first.fail, first.detail);
    const total = countOf(first.html);
    if (total === null || !first.html.includes('id="search-results"')) {
      return cu('layout_changed', first.html.slice(0, 300));
    }

    if (total === 0) {
      // The site answered normally with an empty result. (The home page's /registrant/status poll is not used:
      // a second request made the Windows worker runner abort on exit.)
      return { status: 'not_found', reason: '', records: [], source_url, excerpt: `Register search for "${searchName}": 0 results` };
    }

    const pages = Math.ceil(total / PAGE_SIZE);
    const seen = new Set();
    const matches = [];
    let read = 0;
    const absorb = (html) => {
      for (const r of parseRecords(html)) {
        const id = r.registration_number || `${r.architect}|${r.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        read++;
        if (nameKey(r.name) === wanted) matches.push(r);
      }
    };

    absorb(first.html);
    let next = 1;
    let failure = null;
    while (next < pages && !failure) {
      if (Date.now() - started > BUDGET_MS) break;
      const batch = [];
      for (let p = next; p < Math.min(next + BATCH, pages); p++) batch.push(p);
      next += batch.length;
      const got = await Promise.all(batch.map((p) => fetchPage(searchName, p)));
      for (const g of got) {
        if (g.fail) { failure = g; break; }
        absorb(g.html);
      }
    }
    const complete = !failure && next >= pages;
    const note = `read ${read} of ${total} register entries for "${searchName}"`;

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches.slice(0, MAX_RECORDS),
        source_url,
        excerpt: `${matches.length} entries with practice "${matches[0].name}"; ${note}${complete ? '' : ' (scan incomplete)'}`,
      };
    }
    if (complete) {
      return { status: 'not_found', reason: '', records: [], source_url, excerpt: `No entry with practice "${searchName}"; ${note}` };
    }
    if (failure) return cu(failure.fail, `${failure.detail}; ${note}`);
    return cu('timeout', `time limit reached; ${note}; the practice was not among them`);
  } catch (err) {
    return cu('other', String(err && err.message ? err.message : err));
  }
}
