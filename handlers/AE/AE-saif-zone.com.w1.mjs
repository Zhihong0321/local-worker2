export const meta = {
  task: 'AE-saif-zone.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'business_type', 'telephone', 'email', 'po_box', 'site_id'],
  canary: { found: 'AXIS AUDITING & ACCOUNTING', not_found: 'شركة النخبة الزرقاء للتجارة ذ.م.م' },
};

// SAIF Zone "Auditors Directory" (https://www.saif-zone.com/en/auditors-directory/). The page loads its list with a
// plain GET to the endpoint below. The site's keyword search finds nothing when the keyword contains "&" or a legal
// form, so the handler searches shorter terms and compares the normalised names itself.
const LIST_URL = 'https://www.saif-zone.com/umbraco/surface/LoadMore/RenderAuditorItems';
const POPUP_URL = 'https://www.saif-zone.com/umbraco/surface/LoadMore/RenderInvestorPopUp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const PAGE_SIZE = 20;
const MAX_PAGES = 5;            // per search term
const LIST_BUDGET_MS = 40000;   // no new list page after this
const DETAIL_BUDGET_MS = 50000; // no new detail popup after this
const MAX_DETAIL = 10;

// Legal-form endings as normalised token sequences (upper case, letters and digits only, "&" read as AND).
const LEGAL_TAILS = [
  ['L', 'L', 'C'], ['LLC'], ['FZ', 'LLC'], ['FZCO'], ['FZE'], ['S', 'P', 'C'], ['SPC'], ['LLP'], ['PJSC'],
  ['P', 'J', 'S', 'C'], ['SDN', 'BHD'], ['PTE', 'LTD'], ['PVT', 'LTD'], ['PRIVATE', 'LIMITED'], ['LTD'], ['LIMITED'], ['INC'],
];

// The same legal forms written as text, removed from the end of the typed name before it is used as a search term.
const LEGAL_TEXT_TAIL = /(?:^|[\s,.\-]+)(?:L\.?\s?L\.?\s?C\.?|FZ[\s\-]?LLC|FZCO|FZE|S\.?\s?P\.?\s?C\.?|SPC|LLP|P\.?J\.?S\.?C\.?|PJSC|SDN\.?\s*BHD\.?|PTE\.?\s*LTD\.?|PVT\.?\s*LTD\.?|PRIVATE\s+LIMITED|LTD\.?|LIMITED|INC\.?)\s*$/i;

function tokens(str) {
  return String(str || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

function stripLegal(toks) {
  let t = toks.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (const tail of LEGAL_TAILS) {
      const start = t.length - tail.length;
      if (start > 0 && tail.every((w, i) => t[start + i] === w)) {
        t = t.slice(0, start);
        changed = true;
        break;
      }
    }
  }
  return t;
}

function coreName(typed) {
  let s = typed.replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(LEGAL_TEXT_TAIL, '').trim();
  } while (s !== prev && s.length > 0);
  return s || typed;
}

// Search terms, in order: the part before "&" (if any), the whole core name without "&", then its first word.
function searchTerms(typed) {
  const core = coreName(typed);
  const terms = [];
  const add = (t) => { t = t.replace(/\s+/g, ' ').trim(); if (t.length >= 2 && !terms.includes(t)) terms.push(t); };
  if (core.includes('&')) add(core.split('&')[0]);
  if (!core.includes('&')) add(core);
  add(core.split(/\s+/)[0].replace(/&/g, ''));
  return terms;
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

// One row per company: name, business type and the site's own id (data-page-id) for the detail popup.
function parseRows(html) {
  const rows = [];
  // Captures contain no tags, so a match cannot run from the header row into the first company row.
  const re = /<div class="col1">\s*<span>([^<]*)<\/span>\s*<\/div>\s*<div class="col2">\s*<span>([^<]*)<\/span>\s*<\/div>\s*<div class="col3">\s*<span class="iDPupBtn" data-page-id="(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    rows.push({ name: decode(m[1]), business_type: decode(m[2]), site_id: m[3] });
  }
  return rows;
}

// Detail popup: a two-column table of label : value.
function parsePopup(html) {
  const out = {};
  const re = /<td><span>([^<:]+?)\s*:\s*<\/span><\/td>\s*<td>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = decode(m[1]).toLowerCase();
    const value = decode(m[2].replace(/<[^>]+>/g, ' '));
    if (label.startsWith('po box')) out.po_box = value;
    else if (label.startsWith('telephone')) out.telephone = value;
    else if (label.startsWith('e-mail')) out.email = value;
  }
  return out;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function listUrl(term, page) {
  return `${LIST_URL}?numberOfItems=${PAGE_SIZE}&page=${page}&keyword=${encodeURIComponent(term)}`;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const typed = String(keyword || '').replace(/\s+/g, ' ').trim();
  let firstUrl = LIST_URL;
  try {
    if (!typed) return couldnt('other', LIST_URL, 'empty company name');
    const wanted = stripLegal(tokens(typed)).join(' ');
    if (!wanted) return couldnt('other', LIST_URL, 'no company name left to compare');
    const terms = searchTerms(typed);
    firstUrl = listUrl(terms[0], 1);

    // 1. Search each term, page by page, and keep the rows whose normalised name equals the typed name.
    const matches = [];
    let matchUrl = '';
    let incomplete = false;
    for (const term of terms) {
      let termComplete = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (Date.now() - started > LIST_BUDGET_MS) { incomplete = true; break; }
        const url = listUrl(term, page);
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (res.status === 403 || res.status === 429 || res.status === 503) {
          return couldnt('blocked', url, `HTTP ${res.status}`);
        }
        if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);
        const html = await res.text();
        if (!html.includes('idRowWrap') || !html.includes('idHead')) {
          if (/captcha|cf-chl|just a moment|access denied|verify you are human/i.test(html)) {
            return couldnt('blocked', url, html.replace(/<[^>]+>/g, ' ').slice(0, 300));
          }
          return couldnt('layout_changed', url, html.replace(/\s+/g, ' ').slice(0, 300));
        }
        const rows = parseRows(html);
        for (const r of rows) {
          if (stripLegal(tokens(r.name)).join(' ') === wanted && !matches.some((x) => x.site_id === r.site_id)) {
            matches.push(r);
            if (!matchUrl) matchUrl = url;
          }
        }
        if (rows.length < PAGE_SIZE) { termComplete = true; break; }
        if (page === MAX_PAGES) incomplete = true;
      }
      if (matches.length) break;
      if (!termComplete) incomplete = true;
    }

    // 2. No match: "not found" only when every term was read to its end.
    if (matches.length === 0) {
      if (incomplete) {
        return couldnt('other', firstUrl, `search for "${typed}" was not read to the end (too many rows or time limit); no exact match yet`);
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: firstUrl,
        excerpt: `No row in the SAIF Zone Auditors Directory matches "${typed}" (searched: ${terms.map((t) => `"${t}"`).join(', ')}). This directory lists auditing and tax firms.`,
      };
    }

    // 3. Detail popup for each match (the list gives only name and type).
    const records = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const rec = { name: m.name, business_type: m.business_type, telephone: '', email: '', po_box: '', site_id: m.site_id };
      if (i < MAX_DETAIL && Date.now() - started < DETAIL_BUDGET_MS) {
        try {
          const r = await fetch(`${POPUP_URL}?AutoId=${encodeURIComponent(m.site_id)}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
          if (r.ok) {
            const d = parsePopup(await r.text());
            rec.telephone = d.telephone || '';
            rec.email = d.email || '';
            rec.po_box = d.po_box || '';
          }
        } catch (_) {
          // keep the list fields; the match itself is proven by the list row
        }
      }
      records.push(rec);
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matchUrl || firstUrl,
      excerpt: records.map((r) => `${r.name} | ${r.business_type} | ${r.telephone} | ${r.email}`).join(' ;; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return couldnt(timeout ? 'timeout' : 'other', firstUrl, String((err && err.message) || err).slice(0, 300));
  }
}
