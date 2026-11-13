export const meta = {
  task: 'NZ-interest.co.nz',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'nzx_code', 'nzx50_rank', 'industry_sector', 'head_office', 'chairman', 'chief_executive', 'financial_year_end', 'locations', 'auditor'],
  canary: { found: 'Fisher & Paykel Healthcare', not_found: 'Te Whare Pounamu Limited' },
};

const LIST_URL = 'https://www.interest.co.nz/nzx50';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'corporation', 'corp', 'incorporated', 'inc', 'company', 'co', 'plc', 'llc']);

function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised name words: lower case, '&' = 'and', punctuation dropped, trailing legal form dropped. */
function words(name) {
  const w = String(name || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => (t === '&' ? 'and' : t.replace(/[^a-z0-9]/g, '')))
    .filter(Boolean);
  while (w.length > 1 && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
  return w;
}

function isPrefix(short, kw) {
  return short.length > 0 && short.length <= kw.length && short.every((t, i) => t === kw[i]);
}

function couldnt(source_url, reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

function classify(err) {
  const n = err && err.name;
  return n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'other';
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const body = res.ok ? await res.text() : '';
  return { status: res.status, ok: res.ok, body };
}

function isBotPage(body) {
  return /Just a moment|challenge-platform|cf-chl-/i.test(body);
}

/** Rows of the NZX50 table: rank, ticker (from /nzx50/<ticker>), short name. */
function parseList(html) {
  const rows = [];
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const link = chunk.match(/href="\/nzx50\/([a-z0-9-]+)"/i);
    if (!link) continue;
    const cells = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]));
    const rank = parseInt(cells[0], 10);
    const name = cells[2];
    if (!Number.isFinite(rank) || !name) continue;
    rows.push({ rank, ticker: link[1].toLowerCase(), name });
  }
  return rows;
}

/** Value of a "Label:" row in a company profile table. Site placeholders such as "[no data]" become ''. */
function field(html, label) {
  const m = html.match(new RegExp('<td>\\s*' + label + ':\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>', 'i'));
  if (!m) return null;
  const v = clean(m[1]);
  return /^\[.*\]$/.test(v) ? '' : v;
}

async function profile(row) {
  const url = `https://www.interest.co.nz/nzx50/${row.ticker}`;
  try {
    const p = await get(url);
    if (p.status === 403 || p.status === 429) return { error: couldnt(url, 'blocked', `HTTP ${p.status}`) };
    if (!p.ok) return { error: couldnt(url, 'http_error', `HTTP ${p.status}`) };
    if (isBotPage(p.body)) return { error: couldnt(url, 'blocked', 'bot check page') };
    const legal = field(p.body, 'Legal name');
    if (!legal) return { error: couldnt(url, 'layout_changed', clean(p.body).slice(0, 300)) };
    return {
      row,
      url,
      data: {
        legal_name: legal,
        nzx_code: field(p.body, 'NZX code') || row.ticker.toUpperCase(),
        industry_sector: field(p.body, 'Industry sector') || '',
        head_office: field(p.body, 'Head office') || '',
        chairman: field(p.body, 'Chairman') || '',
        chief_executive: field(p.body, 'Chief executive') || '',
        financial_year_end: field(p.body, 'Financial year ended') || '',
        locations: field(p.body, 'Locations') || '',
        auditor: field(p.body, 'Auditor') || '',
      },
    };
  } catch (err) {
    return { error: couldnt(url, classify(err), String(err && err.message || err)) };
  }
}

async function lookupOnce(keyword) {
  try {
    const text = String(keyword || '').trim();
    const kwWords = words(text);
    if (kwWords.length === 0) return couldnt(LIST_URL, 'other', 'empty company name');
    const kwKey = kwWords.join('');

    const list = await get(LIST_URL);
    if (list.status === 403 || list.status === 429) return couldnt(LIST_URL, 'blocked', `HTTP ${list.status}`);
    if (!list.ok) return couldnt(LIST_URL, 'http_error', `HTTP ${list.status}`);
    if (isBotPage(list.body)) return couldnt(LIST_URL, 'blocked', 'bot check page');

    const rows = parseList(list.body);
    if (rows.length < 10) return couldnt(LIST_URL, 'layout_changed', clean(list.body).slice(0, 300));

    // Only companies whose short name is the start of the keyword can be the same company.
    const candidates = rows.filter((r) => isPrefix(words(r.name), kwWords));
    if (candidates.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `${text} is not among the ${rows.length} NZX50 companies on this page`,
      };
    }

    const results = await Promise.all(candidates.map(profile));
    const matches = results.filter((r) => r.data && (words(r.row.name).join('') === kwKey || words(r.data.legal_name).join('') === kwKey));
    if (matches.length > 0) {
      const records = matches.map((m) => ({
        name: m.row.name,
        legal_name: m.data.legal_name,
        nzx_code: m.data.nzx_code,
        nzx50_rank: m.row.rank,
        industry_sector: m.data.industry_sector,
        head_office: m.data.head_office,
        chairman: m.data.chairman,
        chief_executive: m.data.chief_executive,
        financial_year_end: m.data.financial_year_end,
        locations: m.data.locations,
        auditor: m.data.auditor,
      }));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0].url,
        excerpt: `Legal name: ${matches[0].data.legal_name}; NZX code: ${matches[0].data.nzx_code}; Head office: ${matches[0].data.head_office}`,
      };
    }

    // No match: a failed profile check could have been the match, so it is not a not_found.
    const failed = results.find((r) => r.error);
    if (failed) return failed.error;

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt: `${text} does not match any NZX50 company profile on this page`,
    };
  } catch (err) {
    return couldnt(LIST_URL, classify(err), String(err && err.message || err));
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short wait lets the sockets close before the worker exits: Node on Windows asserts (exit 127) when the
 * process exits right after a fetch, even though the answer was already printed.
 */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}
