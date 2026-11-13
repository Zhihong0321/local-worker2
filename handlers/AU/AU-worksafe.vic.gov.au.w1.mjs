export const meta = {
  task: 'AU-worksafe.vic.gov.au',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'type', 'acn', 'date_offence', 'date_outcome', 'date_published', 'section', 'fine', 'costs', 'court_number', 'summary', 'url'],
  canary: { found: 'Tooradin Excavations Pty Ltd', not_found: 'Zxqvbnm Holdings Pty Ltd' },
};

// The prosecution directory on worksafe.vic.gov.au loads its list from this public JSON search (no login, no token).
const API = 'https://content-v2.api.worksafe.vic.gov.au/api/v2/search-record';
const SITE = 'https://www.worksafe.vic.gov.au';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROWS = 50;
const MAX_PAGES = 4;
const DEADLINE_MS = 30000;

const LEGAL = new Set(['pty', 'ltd', 'limited', 'proprietary', 'company', 'co', 'inc', 'incorporated', 'llc', 'pl', 'the']);
const LEGAL_END = /\b(pty\.?\s*ltd\.?|pty\.?|ltd\.?|limited|proprietary limited)\s*$/i;

function words(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean);
}

/** The name without legal-form words, so "ACME PTY LTD" and "Acme Pty. Ltd." compare equal. */
function core(s) {
  return words(s).filter((w) => !LEGAL.has(w)).join(' ');
}

function clean(x) {
  return String(x).replace(/\bat the time of the offence\b/gi, ' ').replace(/\b(known as|named)\b/gi, ' ');
}

/** Contents of the outermost (...) groups, nesting kept: "A (B (C) D) E" gives ["B (C) D"]. */
function brackets(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
    else if (ch === ')' && depth > 0) { depth--; if (depth === 0) { out.push(cur); continue; } }
    if (depth > 0) cur += ch;
  }
  return out;
}

/** Names a record can be known by: the full title, the parts around "formerly known as", joint parties, and bracketed former names. */
function candidates(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const out = new Set();
  const add = (x) => { const c = core(clean(x)); if (c) out.add(c); };
  add(t);
  let bare = t;
  for (const b of brackets(t)) bare = bare.replace(`(${b})`, ' ');
  add(bare);
  for (const p of t.split(/\s+(?:formerly known as|formerly|known as|trading as|t\/a)\s+/i)) {
    add(p);
    const parts = p.split(/\s+and\s+/i);
    if (parts.length > 1 && parts.every((x) => LEGAL_END.test(x.trim()))) parts.forEach(add);
  }
  for (const inner of brackets(t)) {
    const cl = clean(inner).trim();
    if (LEGAL_END.test(cl)) add(cl);
  }
  return [...out];
}

/** Lite search returns some dates as epoch seconds; turn either form into YYYY-MM-DD. */
function isoDate(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString().slice(0, 10);
  return '';
}

function plain(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function couldnt(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || API, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const name = String(keyword || '').trim();
    const want = core(name);
    const terms = words(name).filter((w) => !LEGAL.has(w)).join(' ');
    if (!want) return couldnt('other', 'the name has no company words to search for');

    const pageUrl = (start) => `${API}?record_type=prs&rows=${ROWS}&start=${start}&query=${encodeURIComponent(terms)}&model=lite&_format=json`;
    const firstUrl = pageUrl(0);
    const matches = [];
    const seen = new Set();
    let total = null;
    let fetched = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && (Date.now() - started > DEADLINE_MS || (total !== null && fetched >= total))) break;
      const url = pageUrl(page * ROWS);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`, url);
      if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`, url);

      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch {
        return couldnt(/captcha|challenge|cf-chl|are you a robot|access denied/i.test(text) ? 'blocked' : 'layout_changed', text.slice(0, 200), url);
      }
      if (!j || !Array.isArray(j.results) || typeof j.numFound !== 'number') {
        return couldnt('layout_changed', text.slice(0, 200), url);
      }
      total = j.numFound;
      if (j.results.length === 0) break;
      fetched += j.results.length;

      for (const r of j.results) {
        if (!r || typeof r.record_title !== 'string') continue;
        if (!candidates(r.record_title).includes(want)) continue;
        const key = r.url || `${r.record_title}|${r.record_prs_dateoffence || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = (r.data && r.data.attributes) || {};
        const p = a.prs || {};
        matches.push({
          name: r.record_title,
          type: a.field_prs_type || '',
          acn: a.field_prs_acn || (r.record_prs_acn ? String(r.record_prs_acn) : ''),
          date_offence: isoDate(a.field_prs_dateoffence ?? r.record_prs_dateoffence),
          date_outcome: isoDate(a.field_prs_dateoutcome ?? r.record_prs_dateoutcome),
          date_published: isoDate(a.field_prs_datepublished ?? r.record_prs_datepublished),
          section: p.section || '',
          fine: p.fine || '',
          costs: p.costs || '',
          court_number: p.court_number || '',
          summary: plain(a.field_body && a.field_body.value).slice(0, 600),
          url: r.url ? new URL(r.url, SITE).href : '',
        });
      }
    }

    const truncated = total !== null && fetched < total;
    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: firstUrl,
        excerpt: `${matches.length} record(s) for "${name}": ${first.name}; offence ${first.date_offence}, published ${first.date_published}` +
          (truncated ? `. ${total} results in total, only the first ${fetched} were checked` : ''),
      };
    }
    if (truncated) return couldnt('other', `${total} results for "${terms}", only the first ${fetched} were checked, none matched the name`, firstUrl);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `${total ?? 0} search result(s) for "${terms}", none with the name "${name}"`,
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', String(err?.message || err), API);
  }
}
