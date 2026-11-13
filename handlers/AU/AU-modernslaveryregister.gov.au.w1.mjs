export const meta = {
  task: 'AU-modernslaveryregister.gov.au',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'identifier_type', 'identifier', 'role', 'statement_id', 'statement_url', 'period', 'statement_number', 'annual_revenue', 'countries'],
  canary: { found: 'WOOLWORTHS GROUP LIMITED', not_found: 'Zxqvbnmlkj Holdings Pty Ltd' },
};

const BASE = 'https://modernslaveryregister.gov.au';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
const MAX_STATEMENTS = 25; // statements whose entity lists are opened, one page each
const POOL = 4;           // parallel statement pages, to stay polite
const OVERALL_MS = 55000; // the whole call must finish under 60 s
const LEGAL_FORM = new Set(['PTY', 'LTD', 'LIMITED', 'PTE', 'INC', 'CORP', 'CORPORATION', 'LLC', 'CO', 'COMPANY']);

class Fail extends Error {
  constructor(reason, excerpt, url) {
    super(reason);
    this.reason = reason;
    this.excerpt = excerpt;
    this.url = url;
  }
}

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised company name: upper case, punctuation and spaces removed, legal-form words removed. */
function normName(s) {
  return (s || '')
    .toUpperCase()
    .replace(/&/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_FORM.has(t))
    .join('');
}

async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    const timed = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Fail(timed ? 'timeout' : 'other', String((e && e.message) || e).slice(0, 200), url);
  }
  if (res.status === 403 || res.status === 429) throw new Fail('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw new Fail('http_error', `HTTP ${res.status}`, url);
  let html;
  try {
    html = await res.text();
  } catch (e) {
    throw new Fail('timeout', 'body not received: ' + String((e && e.message) || e).slice(0, 150), url);
  }
  const hasResults = html.includes('search-results__') || html.includes('statement-entity');
  if (!hasResults && /captcha|access denied|are you a robot/i.test(html)) {
    throw new Fail('blocked', 'bot or captcha page', url);
  }
  return html;
}

/** The search results page: a count and one link per statement. */
function parseSearch(html, url) {
  if (!html.includes('search-results__form-counter')) {
    throw new Fail('layout_changed', clean(html).slice(0, 300), url);
  }
  const counterHtml = (html.match(/search-results__form-counter">([\s\S]*?)<\/p>/) || [])[1] || '';
  const counter = clean(counterHtml);
  const m = counter.match(/\((\d[\d,]*) statements?\)/i);
  if (!m) throw new Fail('layout_changed', 'no statement count: ' + counter.slice(0, 200), url);
  const total = Number(m[1].replace(/,/g, ''));

  const items = [];
  const re = /<a href="(\/statements\/(\d+)\/)" class="search-results__item"[^>]*>([\s\S]*?)<\/a>/g;
  let x;
  while ((x = re.exec(html))) {
    const periodHtml = (x[3].match(/search-results__item-period"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
    items.push({ id: x[2], url: BASE + x[1], period: clean(periodHtml) });
  }
  return { total, items, counter };
}

function entitiesIn(chunk, role) {
  const out = [];
  for (const part of chunk.split('class="statement-entity"').slice(1)) {
    const nm = part.match(/statement-entity__name-link"[^>]*>([\s\S]*?)<\/a>/);
    if (!nm) continue;
    const name = clean(nm[1]);
    const idm = part.match(/(ACN|ABN):\s*(?:<a[^>]*>)?([^<]*)/);
    out.push({
      name,
      role,
      identifier_type: idm ? idm[1] : '',
      identifier: idm ? idm[2].replace(/\s+/g, ' ').trim() : '',
    });
  }
  return out;
}

/** One statement page: the reporting entities and the included entities, with ACN/ABN. */
function parseStatement(html, url) {
  const repIdx = html.indexOf('id="statement-reporting-entities-accordion"');
  if (repIdx < 0 || !html.includes('statement-entity__name')) {
    throw new Fail('layout_changed', 'no reporting entity list: ' + clean(html).slice(0, 200), url);
  }
  const incIdx = html.indexOf('id="statement-included-entities-accordion"');
  const relIdx = html.indexOf('id="statement-related-reports-header"');
  const end = relIdx > repIdx ? relIdx : html.length;

  const repEnd = incIdx > repIdx ? incIdx : end;
  const entities = entitiesIn(html.slice(repIdx, repEnd), 'reporting entity');
  if (incIdx > repIdx) entities.push(...entitiesIn(html.slice(incIdx, end), 'included entity'));

  const t = clean(html);
  const pick = (re) => ((t.match(re) || [])[1] || '').trim();
  return {
    entities,
    statement_number: pick(/Number\s+(\S+)\s+Type/),
    annual_revenue: pick(/Annual revenue\s+(.+?)\s+Industry sectors/),
    countries: pick(/Countries\s+(.+?)\s+Reporting entities/),
  };
}

async function pool(list, size, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function check(keyword, searchUrl) {
  const kw = normName(keyword);
  if (!kw) return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
  try {
    const searchHtml = await fetchPage(searchUrl);
    const { total, items, counter } = parseSearch(searchHtml, searchUrl);

    if (total === 0 && items.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: counter.slice(0, 300) };
    }
    if (items.length !== total) {
      throw new Fail('other', `page lists ${items.length} of ${total} statements; the rest were not read`, searchUrl);
    }
    if (items.length > MAX_STATEMENTS) {
      throw new Fail('other', `${items.length} statements matched; the handler reads up to ${MAX_STATEMENTS}`, searchUrl);
    }

    const results = await pool(items, POOL, async (item) => {
      try {
        const html = await fetchPage(item.url);
        return { item, ok: true, parsed: parseStatement(html, item.url) };
      } catch (e) {
        const fail = e instanceof Fail ? e : new Fail('other', String((e && e.message) || e).slice(0, 200), item.url);
        return { item, ok: false, fail };
      }
    });

    const records = [];
    const failures = [];
    for (const r of results) {
      if (!r.ok) {
        failures.push(r.fail);
        continue;
      }
      for (const ent of r.parsed.entities) {
        if (normName(ent.name) !== kw) continue;
        records.push({
          name: ent.name,
          identifier_type: ent.identifier_type,
          identifier: ent.identifier,
          role: ent.role,
          statement_id: r.item.id,
          statement_url: r.item.url,
          period: r.item.period,
          statement_number: r.parsed.statement_number,
          annual_revenue: r.parsed.annual_revenue,
          countries: r.parsed.countries,
        });
      }
    }

    if (records.length) {
      return { status: 'found', reason: '', records, source_url: searchUrl, excerpt: `${records.length} match(es) in ${items.length} statements. ${counter}`.slice(0, 500) };
    }
    if (failures.length) {
      const f = failures[0];
      return {
        status: 'couldnt_check',
        reason: f.reason,
        records: [],
        source_url: f.url,
        excerpt: `could not read ${failures.length} of ${items.length} statements; first: ${f.excerpt}`.slice(0, 500),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `${items.length} statements matched the search; none lists this name as a reporting or included entity`,
    };
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail('other', String((e && e.message) || e).slice(0, 200), searchUrl);
    return { status: 'couldnt_check', reason: f.reason, records: [], source_url: f.url || searchUrl, excerpt: String(f.excerpt).slice(0, 500) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = `${BASE}/statements/?q=${encodeURIComponent(String(keyword || ''))}`;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'couldnt_check', reason: 'timeout', records: [], source_url: searchUrl, excerpt: 'the handler did not finish in 55 s',
    }), OVERALL_MS);
  });
  try {
    return await Promise.race([check(String(keyword || ''), searchUrl), deadline]);
  } catch (e) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: String((e && e.message) || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
