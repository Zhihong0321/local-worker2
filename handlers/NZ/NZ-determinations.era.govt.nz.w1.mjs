export const meta = {
  task: 'NZ-determinations.era.govt.nz',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'parties', 'citation', 'date', 'member', 'office', 'determination_url', 'pdf_url'],
  canary: { found: 'DAVIS TRADING COMPANY LIMITED', not_found: 'Zorvantha Quillbee Limited' },
};

const BASE = 'https://determinations.era.govt.nz';
const SEARCH_PATH = '/determinations/DeterminationSearchForm';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MAX_RESULTS = 200;   // at most 20 result pages are read
const BATCH = 4;           // result pages fetched at a time
const DEADLINE_MS = 45000; // stop starting new pages after 45 s
const LEGAL_FORMS = new Set(['limited', 'ltd', 'incorporated', 'inc', 'llc', 'lp', 'plc']);
const AND_OTHERS = new Set(['anor', 'ors', 'others', 'anr']);

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words of a party name with punctuation, "and Anor" and legal form removed, lower case. */
function coreName(str) {
  let t = (str || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (t.length >= 2 && t[t.length - 2] === 'and' && AND_OTHERS.has(t[t.length - 1])) t = t.slice(0, -2);
  return t.filter((w) => !LEGAL_FORMS.has(w)).join(' ');
}

/** The search term: the name's words without punctuation or legal form. */
function searchTerm(keyword) {
  return (keyword || '')
    .replace(/&/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w.toLowerCase()))
    .join(' ');
}

function searchUrl(term, start) {
  const u = new URL(SEARCH_PATH, BASE);
  u.searchParams.set('Parties', term);
  u.searchParams.set('action_doSearch', 'Search');
  if (start > 0) u.searchParams.set('start', String(start));
  return u.href;
}

function parseRecords(html) {
  const out = [];
  const blocks = html.split('<li class="search-results__record">').slice(1);
  for (const block of blocks) {
    const title = block.match(/<p class="search-results__record__title">\s*<a href="([^"]*)">([\s\S]*?)<\/a>/);
    if (!title) continue;
    const member = block.match(/<\/p>\s*<p>([^<]*?)\s*\[([^\]]*)\]\s*<\/p>/);
    const date = block.match(/<p>\s*(\d{1,2} [A-Za-z]+ \d{4})\s*<\/p>/);
    const citation = block.match(/<p>\s*(\[\d{4}\] NZERA \d+)\s*<\/p>/);
    const pdf = block.match(/href="(\/assets\/elawpdf\/[^"]+)"/);
    out.push({
      parties: cleanText(title[2]),
      determination_url: new URL(title[1], BASE).href,
      member: member ? cleanText(member[1]) : '',
      office: member ? cleanText(member[2]) : '',
      date: date ? cleanText(date[1]) : '',
      citation: citation ? cleanText(citation[1]) : '',
      pdf_url: pdf ? new URL(pdf[1], BASE).href : '',
    });
  }
  return out;
}

/** The party in a title such as "LEONARD v EASY WAY GROUP LIMITED" that is the company, or '' if none is. */
function matchingParty(parties, kwCore) {
  const side = parties.split(/\s+v\s+/i).find((s) => coreName(s) === kwCore);
  return side ? side.replace(/\s+and\s+(anor|ors|others|anr)\s*$/i, '').trim() : '';
}

async function getPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { error: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { error: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    if (/<title>[^<]*(Access Denied|Attention Required|Just a moment|Request Rejected)/i.test(html)) {
      return { error: 'blocked', detail: 'bot or access check page' };
    }
    return { html };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { error: timeout ? 'timeout' : 'other', detail: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kwCore = coreName(keyword);
  const term = searchTerm(keyword);
  const firstUrl = searchUrl(term, 0);
  try {
    if (!kwCore) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: 'no searchable words in the name' };
    }

    const first = await getPage(firstUrl);
    if (first.error) {
      return { status: 'couldnt_check', reason: first.error, records: [], source_url: firstUrl, excerpt: first.detail };
    }
    const html = first.html;
    const summary = html.match(/Results\s+(\d+)-(\d+)\s+of\s+(\d+)/i);
    const noMatch = /did not match any cases/i.test(html);
    if (!summary && !noMatch) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: firstUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const total = summary ? parseInt(summary[3], 10) : 0;
    const records = [];
    const seen = new Set();
    const addPage = (pageHtml) => {
      for (const r of parseRecords(pageHtml)) {
        if (seen.has(r.determination_url)) continue;
        seen.add(r.determination_url);
        const party = matchingParty(r.parties, kwCore);
        if (party) records.push({ name: party, ...r });
      }
    };
    addPage(html);

    // Later result pages, only when the search returned more than one page.
    const limit = Math.min(total, MAX_RESULTS);
    const starts = [];
    for (let s = PAGE_SIZE; s < limit; s += PAGE_SIZE) starts.push(s);
    let failure = null;
    let checkedTo = Math.min(total, PAGE_SIZE);
    for (let i = 0; i < starts.length && !failure; i += BATCH) {
      if (Date.now() - started > DEADLINE_MS) {
        failure = { error: 'timeout', detail: `stopped after ${checkedTo} of ${total} results` };
        break;
      }
      const batch = starts.slice(i, i + BATCH);
      const pages = await Promise.all(batch.map((s) => getPage(searchUrl(term, s))));
      for (let j = 0; j < pages.length; j++) {
        if (pages[j].error) {
          failure = pages[j];
          break;
        }
        addPage(pages[j].html);
        checkedTo = Math.max(checkedTo, batch[j] + PAGE_SIZE);
      }
    }

    if (records.length > 0) {
      const partial = failure || total > MAX_RESULTS ? ` (checked ${Math.min(checkedTo, total)} of ${total} results)` : '';
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstUrl,
        excerpt: `${records.length} determination(s) name this company as a party${partial}`,
      };
    }
    if (failure) {
      return { status: 'couldnt_check', reason: failure.error, records: [], source_url: firstUrl, excerpt: `${failure.detail}; no match in the results read` };
    }
    if (total > MAX_RESULTS) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl, excerpt: `${total} results, only the first ${MAX_RESULTS} were checked; no match` };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: noMatch && total === 0 ? 'Sorry, your search did not match any cases.' : `${total} search result(s), none names this company as a party`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: firstUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
