export const meta = { task: 'GB-gamblingcommission.gov.uk', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'account_number', 'trading_names', 'domain_names', 'head_office_address', 'licences'],
  canary: { found: 'Hillside (Technology) Limited', not_found: 'Zorbex Quantum Gaming Limited' } };

const BASE = 'https://www.gamblingcommission.gov.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'plc', 'llp', 'lp', 'enc', 'unlimited', 'ulc', 'company', 'co', 'inc']);
const TRAILING_LEGAL = /[\s,]*\b(limited|ltd|plc|llp|lp|enc|unlimited|ulc|inc)\.?\s*$/i;
const DETAIL_BUDGET_MS = 35000;   // stop reading detail pages after this, so the whole call finishes under 60 s
const MAX_DETAILS = 3;

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&rsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: case, accents, punctuation and legal form removed. */
function normalize(name) {
  const s = clean(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ');
  return s.split(/\s+/).filter((t) => t && !LEGAL_FORMS.has(t)).join('');
}

/**
 * The register search is literal: "Hillside (Technology) Limited" finds the company, but
 * "Hillside Technology Limited" and "Hillside Technology" return nothing. So try a few forms of the
 * name and match the legal names of everything they return.
 */
function searchVariants(term) {
  const noLegal = term.replace(TRAILING_LEGAL, '').trim();
  const first = (noLegal.split(/[\s(),.&-]+/).filter(Boolean)[0] || '');
  const out = [term];
  if (noLegal && noLegal !== term) out.push(noLegal);
  if (first.length >= 2 && !out.includes(first)) out.push(first);
  return out;
}

function get(url) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
  });
}

function fail(reason, url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: url, excerpt: String(excerpt).slice(0, 300) };
}

/** Search results list: one entry per company on the page. */
function parseResults(html) {
  const items = html.match(/<li class="gcweb-search-result--item[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const li of items) {
    const link = li.match(/<a href="\/public-register\/business\/detail\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const acct = li.match(/Account\s+number:\s*<\/strong>\s*(\d+)/i);
    const trading = li.match(/Trading\s*as:\s*<\/strong>([\s\S]*?)(?=<p|<\/li>)/i);
    const domainBlock = li.match(/<ul class="gc-meta-tag">([\s\S]*?)<\/ul>/i);
    const domains = domainBlock ? (domainBlock[1].match(/<li[^>]*>[\s\S]*?<\/li>/g) || []).map(clean)
      .filter((d) => d && !/^No matching domain names$/i.test(d)) : [];
    out.push({
      detail_id: link[1],
      name: clean(link[2]),
      account_number: acct ? acct[1] : '',
      trading_names: trading ? clean(trading[1]).split(',').map((t) => t.trim()).filter(Boolean) : [],
      domain_names: domains,
    });
  }
  return out;
}

/** Licence summary page of one company: head office address, account number and licence rows. */
function parseDetail(html) {
  const acct = html.match(/Account number[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  const addr = html.match(/Head office address[\s\S]*?<address[^>]*>([\s\S]*?)<\/address>/i);
  const section = html.match(/Licence summary<\/h2>([\s\S]*?)<\/table>/i);
  const licences = [];
  for (const row of (section ? section[1] : '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(clean);
    if (cells.length >= 4) licences.push({ activity: cells[0], status: cells[1], from: cells[2], to: cells[3] });
  }
  return {
    account_number: acct ? clean(acct[1]) : '',
    head_office_address: addr ? clean(addr[1]) : '',
    licences,
  };
}

/** One search request. Returns { url, items } or { failure } when the site refused or did not answer normally. */
async function runSearch(term) {
  const url = `${BASE}/public-register/businesses/results?business-search=${encodeURIComponent(term)}`;
  const res = await get(url);
  if (res.status === 403 || res.status === 429) return { failure: fail('blocked', url, `HTTP ${res.status}`) };
  if (!res.ok) return { failure: fail('http_error', url, `HTTP ${res.status}`) };
  const html = await res.text();
  if (/id="search-results"/.test(html)) {
    const items = parseResults(html);
    if (!items.length) return { failure: fail('layout_changed', url, 'results list present but no entries could be read') };
    return { url, items };
  }
  if (/No results for/i.test(html)) return { url, items: [] };
  const blocked = /unusual traffic|are you a robot|verify you are (a )?human|access denied/i.test(html);
  return { failure: fail(blocked ? 'blocked' : 'layout_changed', url, clean(html).slice(0, 300)) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const term = String(keyword || '').trim();
  const typedUrl = `${BASE}/public-register/businesses/results?business-search=${encodeURIComponent(term)}`;
  try {
    const kw = normalize(term);
    if (!kw) return fail('other', typedUrl, 'empty company name');

    const seen = new Map();
    const tried = [];
    let matchedUrl = typedUrl;
    let matches = [];
    for (const variant of searchVariants(term)) {
      const r = await runSearch(variant);
      if (r.failure) return r.failure;   // a site that refuses the search is never not_found
      tried.push(variant);
      for (const it of r.items) if (!seen.has(it.detail_id)) seen.set(it.detail_id, it);
      // The company is the one whose legal name matches, not one that matches only a trading name or domain.
      matches = [...seen.values()].filter((it) => normalize(it.name) === kw);
      if (matches.length) { matchedUrl = r.url; break; }
    }

    if (!matches.length) {
      const names = [...seen.values()].slice(0, 5).map((r) => r.name).join('; ');
      return { status: 'not_found', reason: '', records: [], source_url: typedUrl,
        excerpt: `searched ${tried.map((v) => `"${v}"`).join(', ')}; ` +
          (names ? `no result has this legal name: ${names}` : 'no results') };
    }

    const records = [];
    let details = 0;
    for (const m of matches) {
      const rec = { name: m.name, account_number: m.account_number, trading_names: m.trading_names,
        domain_names: m.domain_names, head_office_address: '', licences: [],
        detail_url: `${BASE}/public-register/business/detail/${m.detail_id}` };
      if (details < MAX_DETAILS && Date.now() - started < DETAIL_BUDGET_MS) {
        details++;
        try {
          const dres = await get(rec.detail_url);
          if (dres.ok) {
            const d = parseDetail(await dres.text());
            rec.account_number = d.account_number || rec.account_number;
            rec.head_office_address = d.head_office_address;
            rec.licences = d.licences;
          } else {
            rec.detail_note = `detail page HTTP ${dres.status}`;
          }
        } catch (err) {
          rec.detail_note = `detail page ${(err && err.name === 'TimeoutError') ? 'timeout' : 'error'}`;
        }
      } else {
        rec.detail_note = 'detail page not read (time budget)';
      }
      records.push(rec);
    }

    const first = records[0];
    const lic = first.licences.map((l) => `${l.activity} | ${l.status} | ${l.from} to ${l.to}`).join(' ; ');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: matchedUrl,
      excerpt: `${first.name}; account ${first.account_number}; ${first.head_office_address}; ${lic}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', typedUrl, (err && err.message) || err);
  }
}
