export const meta = {
  task: 'GB-thegazette.co.uk',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_number', 'notice_type', 'published', 'feed', 'source_url', 'excerpt'],
  canary: { found: 'SHARP EDGE 2 (UK) LTD', not_found: 'Blorvanex Quintrel Holdings Limited' },
};

// The Gazette has two JSON search feeds: notice-level insolvency notices (full text per notice page) and
// London Gazette page hits (snippets only; the page text itself is a PDF). Striking-off and other non-insolvency
// notices appear only in the page feed, so both are searched.
const BASE = 'https://www.thegazette.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' };
const LEGAL = ['ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'cic', 'inc', 'incorporated'];
const PAGE_SIZE = 100;
const NOTICE_CHECKS = 12;
const MAX_RECORDS = 10;

const words = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
/** Name words without the legal form, so "Sharp Edge 2 (UK) Ltd" and "SHARP EDGE 2 (UK) LIMITED" compare equal. */
function coreOf(s) {
  const w = words(s);
  while (w.length && LEGAL.includes(w[w.length - 1])) w.pop();
  return w;
}
const cleanTitle = (t) => String(t || '').replace(/\s+and other companies\s*$/i, '').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (s) => String(s || '')
  .replace(/<\/?em[^>]*>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&apos;|&#39;|&#x27;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Finds the name as written in free text: any non-alphanumeric between words. When the input carried a legal form,
 * the text must carry one too, so "W. G. FOGG B.A." (a person) does not match "G. FOGG LIMITED".
 */
function nameRegex(core, requireLegal) {
  const legal = '(?:[^A-Za-z0-9]+(?:' + LEGAL.join('|') + ')(?![A-Za-z0-9]))' + (requireLegal ? '' : '?');
  return new RegExp('(?<![A-Za-z0-9])' + core.map(esc).join('[^A-Za-z0-9]+') + legal + '(?![A-Za-z0-9])', 'i');
}

async function fetchText(url, accept) {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Accept: accept }, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', url, detail: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', url, detail: `HTTP ${res.status}` };
    return { url, body: await res.text() };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { fail: timeout ? 'timeout' : 'other', url, detail: String((e && e.message) || e).slice(0, 200) };
  }
}

/** One JSON search. The quoted phrase makes the site match the whole name, not single words. */
async function searchFeed(path, core) {
  const url = `${BASE}${path}?` + new URLSearchParams({ text: `"${core.join(' ')}"`, 'results-page-size': String(PAGE_SIZE) });
  const r = await fetchText(url, 'application/json');
  if (r.fail) return r;
  let j;
  try {
    j = JSON.parse(r.body);
  } catch {
    return { fail: /captcha|access denied|unusual traffic|robot/i.test(r.body) ? 'blocked' : 'layout_changed', url, detail: plain(r.body).slice(0, 200) };
  }
  if (!j || typeof j !== 'object' || j['f:total'] === undefined) {
    return { fail: 'layout_changed', url, detail: r.body.slice(0, 200) };
  }
  return { url, total: Number(j['f:total']) || 0, entries: Array.isArray(j.entry) ? j.entry : [] };
}

/** Insolvency notices: title match first, then the notice page text for the rest (multi-company notices, generic titles). */
async function checkInsolvency(core, feed, requireLegal) {
  const key = core.join(' ');
  const re = nameRegex(core, requireLegal);
  const titleHits = [];
  const others = [];
  for (const e of feed.entries) {
    (coreOf(cleanTitle(e.title)).join(' ') === key ? titleHits : others).push(e);
  }
  const ordered = [...titleHits, ...others];
  const toCheck = ordered.slice(0, NOTICE_CHECKS);
  const unchecked = ordered.slice(NOTICE_CHECKS);
  let complete = unchecked.length === 0 && feed.entries.length >= feed.total;
  let fail = null;
  const records = [];

  const checks = await Promise.all(toCheck.map(async (e) => {
    const id = String(e.id || '').split('/').pop();
    const r = await fetchText(`${BASE}/notice/${id}`, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    return { e, id, r };
  }));

  for (const { e, id, r } of checks) {
    const isTitleHit = coreOf(cleanTitle(e.title)).join(' ') === key;
    const url = `${BASE}/notice/${id}`;
    if (r.fail) {
      if (isTitleHit) records.push({ name: cleanTitle(e.title), company_number: '', notice_type: '', published: e.published || '', feed: 'insolvency-notices', source_url: url, excerpt: cleanTitle(e.title) });
      else { complete = false; fail = fail || r.fail; }
      continue;
    }
    const text = plain(r.body);
    const occurrences = [...text.matchAll(new RegExp(re.source, 'gi'))];
    const m = occurrences[0] || null;
    if (!isTitleHit && !m) continue;
    const written = isTitleHit ? cleanTitle(e.title) : m[0];
    const at = m ? m.index : 0;
    // The number that follows a matched name belongs to it; a number elsewhere on the page may be another company's.
    let number = '';
    for (const o of occurrences) {
      const after = text.slice(o.index + o[0].length, o.index + o[0].length + 80);
      const hit = after.match(/Company\s+Number\s*:?\s*([A-Z0-9]{4,12})/i);
      if (hit) { number = hit[1]; break; }
    }
    records.push({
      name: written,
      company_number: number,
      notice_type: ((text.match(/Notice type:\s*(.+?)\s+Publication date:/i) || [])[1]) || '',
      published: e.published || '',
      feed: 'insolvency-notices',
      source_url: url,
      excerpt: text.slice(Math.max(0, at - 120), at + 200),
    });
  }
  // Title hits beyond the notice-check limit still count as matches; they just carry no notice-page details.
  for (const e of unchecked) {
    if (coreOf(cleanTitle(e.title)).join(' ') === key) {
      const id = String(e.id || '').split('/').pop();
      records.push({ name: cleanTitle(e.title), company_number: '', notice_type: '', published: e.published || '', feed: 'insolvency-notices', source_url: `${BASE}/notice/${id}`, excerpt: cleanTitle(e.title) });
    }
  }
  return { records, complete, fail };
}

/** London Gazette page hits: the snippet is the only text available, so the name must appear in it. */
function checkPages(core, feed, requireLegal) {
  const re = nameRegex(core, requireLegal);
  const records = [];
  for (const e of feed.entries) {
    const t = plain(e.content);
    const m = t.match(re);
    if (!m) continue;
    const after = t.slice(m.index + m[0].length).match(/^\s*(\d{6,8}|[A-Z]{2}\d{6})\b/);
    records.push({
      name: m[0],
      company_number: after ? after[1] : '',
      notice_type: '',
      published: e.published || '',
      feed: 'london-gazette-pages',
      source_url: String(e.id || ''),
      excerpt: t.slice(Math.max(0, m.index - 120), m.index + 200),
    });
  }
  return { records, complete: feed.entries.length >= feed.total };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const core = coreOf(keyword);
    if (!core.length) return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    const requireLegal = LEGAL.includes(words(keyword).slice(-1)[0]);

    const [ins, pages] = await Promise.all([
      searchFeed('/insolvency/notice/data.json', core),
      searchFeed('/all-notices/notice/data.json', core),
    ]);

    let records = [];
    let complete = true;
    let fail = null;
    let failUrl = '';
    let failDetail = '';

    if (ins.fail) {
      fail = ins.fail; failUrl = ins.url; failDetail = ins.detail; complete = false;
    } else {
      const r = await checkInsolvency(core, ins, requireLegal);
      records.push(...r.records);
      if (!r.complete) complete = false;
      if (r.fail && !fail) { fail = r.fail; failUrl = ins.url; failDetail = 'a notice page could not be read'; }
    }

    if (pages.fail) {
      fail = fail || pages.fail; failUrl = failUrl || pages.url; failDetail = failDetail || pages.detail; complete = false;
    } else {
      const r = checkPages(core, pages, requireLegal);
      records.push(...r.records);
      if (!r.complete) complete = false;
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records: records.slice(0, MAX_RECORDS),
        source_url: records[0].source_url,
        excerpt: records[0].excerpt,
      };
    }
    if (fail) {
      return { status: 'couldnt_check', reason: fail, records: [], source_url: failUrl, excerpt: failDetail || 'search could not be completed' };
    }
    if (!complete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: ins.url, excerpt: 'the search has more results than the handler reads; not called not_found' };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: `${ins.url} ; ${pages.url}`,
      excerpt: `0 matching names in ${ins.total} insolvency notices and ${pages.total} Gazette page hits for "${core.join(' ')}"`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: BASE,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
