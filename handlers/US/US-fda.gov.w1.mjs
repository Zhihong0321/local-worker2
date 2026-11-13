export const meta = {
  task: 'US-fda.gov',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'letter_issue_date', 'posted_date', 'issuing_office', 'subject', 'letter_url', 'response_letter_url', 'closeout_letter_url', 'excerpt'],
  canary: { found: 'Nanjing Hanxin Pharmaceutical Technology Co. Ltd.', not_found: 'Zxqvbnm Nonexistent Holdings LLC' },
};

// The warning-letter table is a DataTables view. Its own page calls this JSON endpoint with a Solr full-text term.
const SITE = 'https://www.fda.gov';
const LIST_PATH = '/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters';
const AJAX = SITE + '/datatables/views/ajax';
const VIEW_BASE = LIST_PATH.slice(1) + '/datatables-data';
const VIEW_DOM_ID = '2ac2897b100188ab6b46eaf2853b90f4d25721943ce3806b98fb357e673e6592';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 100;
const MAX_PAGES = 10;
const START_BUDGET_MS = 30000; // a new page is started only before 30 s, so the call ends well under 60 s

// Legal-form words are dropped on both sides before comparing, so "ACME LTD" matches "Acme Limited".
const LEGAL = new Set(['ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'plc', 'pvt', 'private', 'pty', 'sdn', 'bhd', 'llp', 'lp',
  'pllc', 'pc', 'kk', 'oy', 'ab', 'spa', 'srl', 'ltda', 'pte', 'jsc']);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = ENT[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function cell(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absUrl(href) {
  try { return new URL(href, SITE).href; } catch { return ''; }
}

function hrefOf(html) {
  const m = String(html || '').match(/href="([^"]+)"/i);
  return m ? absUrl(decode(m[1])) : '';
}

function tokens(str) {
  return String(str || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function coreTokens(str) {
  const t = tokens(str);
  const core = t.filter((x) => !LEGAL.has(x));
  return core.length ? core : t;
}

function coreKey(str) {
  return coreTokens(str).join(' ');
}

function toRecord(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const name = cell(row[2]);
  if (!name) return null;
  return {
    key: coreKey(name),
    record: {
      name,
      letter_issue_date: cell(row[1]),
      posted_date: cell(row[0]),
      issuing_office: cell(row[3]),
      subject: cell(row[4]),
      letter_url: hrefOf(row[2]),
      response_letter_url: hrefOf(row[5]),
      closeout_letter_url: hrefOf(row[6]),
      excerpt: cell(row[7]).slice(0, 500),
    },
  };
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

async function fetchPage(query, start) {
  const u = new URL(AJAX);
  u.search = new URLSearchParams({
    _drupal_ajax: '1',
    _wrapper_format: 'drupal_ajax',
    view_name: 'warning_letter_solr_index',
    view_display_id: 'warning_letter_solr_block',
    view_base_path: VIEW_BASE,
    view_path: LIST_PATH,
    view_dom_id: VIEW_DOM_ID,
    search_api_fulltext: query,
    draw: '1',
    start: String(start),
    length: String(PAGE),
  }).toString();
  const res = await fetch(u.href, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/javascript, */*; q=0.01' },
    signal: AbortSignal.timeout(25000),
  });
  return { res, url: u.href };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = SITE + LIST_PATH;
  try {
    const key = coreKey(keyword);
    if (!key) return out('couldnt_check', 'other', [], searchUrl, 'the company name has no letters or digits to search');

    const t0 = Date.now();
    const matches = [];
    let scanned = 0;
    let total = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 && Date.now() - t0 > START_BUDGET_MS) break;

      const { res, url } = await fetchPage(key, page * PAGE);
      searchUrl = url;

      if (res.status === 403 || res.status === 429) {
        return out('couldnt_check', 'blocked', [], searchUrl, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return out('couldnt_check', 'http_error', [], searchUrl, `HTTP ${res.status}`);
      }

      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch { j = null; }
      if (!j || !Array.isArray(j.data) || typeof j.recordsFiltered !== 'number') {
        const blocked = /captcha|access denied|are you a robot|request blocked/i.test(text.slice(0, 3000));
        return out('couldnt_check', blocked ? 'blocked' : 'layout_changed', [], searchUrl, text.slice(0, 300));
      }

      total = j.recordsFiltered;
      for (const row of j.data) {
        const r = toRecord(row);
        if (r && r.key === key) matches.push(r.record);
      }
      scanned += j.data.length;

      if (j.data.length === 0 || scanned >= total) break;
    }

    if (matches.length) {
      const first = matches[0];
      return out('found', '', matches, searchUrl,
        `${first.name} | ${first.subject} | letter ${first.letter_issue_date} | ${first.issuing_office}`.slice(0, 500));
    }
    if (scanned < total) {
      return out('couldnt_check', 'other', [], searchUrl,
        `search "${key}" has ${total} results; checked ${scanned} and none matched, the rest were not checked in time`);
    }
    return out('not_found', '', [], searchUrl, `the search "${key}" returned ${total} results, none with this company name`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], searchUrl, String((err && err.message) || err).slice(0, 300));
  }
}
