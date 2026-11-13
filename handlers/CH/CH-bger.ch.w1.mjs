export const meta = {
  task: 'CH-bger.ch',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['case_number', 'decision_date', 'court', 'subject', 'object', 'parties', 'decision_url'],
  canary: { found: 'Swisscom AG', not_found: 'Xqzvbnm Treuhand AG' },
};

const BASE = 'https://www.bger.ch';
const SEARCH = BASE + '/ext/eurospider/live/de/php/aza/http/index.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-CH,de;q=0.9,fr;q=0.8,en;q=0.7' };
const MAX_CHECK = 10;          // decisions on the first results page that are opened to read their parties
const CHECK_DEADLINE_MS = 30000; // no new decision is opened after this, so the whole call stays under 60 s
const PARTY_RE = /Verfahrensbeteiligte|Parteien|Parties/;

function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function toText(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Lower-case words with accents removed and punctuation dropped: "Swisscom (Schweiz) AG" -> [swisscom, schweiz, ag] */
function words(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when the needle words appear next to each other, in order, inside the hay words. */
function containsSeq(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function looksBlocked(html) {
  return /Request unsuccessful|Incapsula incident/i.test(html);
}

function cc(reason, excerpt, sourceUrl) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 500) };
}

/** Result rows of the search page: one per decision, with its highlight (full text) link. */
function parseHits(html) {
  const out = [];
  for (const item of html.split(/<li>/i).slice(1)) {
    const m = item.match(/<a href="([^"]*highlight_docid=[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const field = (cls) => toText((item.match(new RegExp(`<div class="${cls}[^"]*">([\\s\\S]*?)<\\/div>`, 'i')) || [])[1] || '');
    out.push({
      url: new URL(decodeEntities(m[1]), BASE).href,
      label: toText(m[2]),
      court: field('court'),
      subject: field('subject'),
      object: field('object'),
    });
  }
  return out;
}

/** Opens one decision and checks whether the company is named in its list of parties. */
async function checkDecision(hit, target) {
  try {
    const res = await fetch(hit.url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked' };
    if (!res.ok) return { ok: false, reason: 'http_error' };
    const html = await res.text();
    if (looksBlocked(html)) return { ok: false, reason: 'blocked' };
    const text = toText(html);
    const m = PARTY_RE.exec(text);
    if (!m) return { ok: false, reason: 'layout_changed' };
    let block = text.slice(m.index, m.index + 700);
    const cut = block.search(/Gegenstand|Sachverhalt|Erwägungen|Regeste/);
    if (cut > 0) block = block.slice(0, cut);
    block = block.slice(0, 400).trim();
    if (!containsSeq(words(block), target)) return { ok: false, reason: 'no_match' };
    const date = (hit.label.match(/\d{2}\.\d{2}\.\d{4}/) || [''])[0];
    const caseNumber = hit.label.replace(date, '').trim();
    return {
      ok: true,
      record: {
        case_number: caseNumber,
        decision_date: date,
        court: hit.court,
        subject: hit.subject,
        object: hit.object,
        parties: block,
        decision_url: hit.url,
      },
    };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'other' };
  }
}

/** Opens the hits two at a time; after the deadline no new decision is opened. */
async function checkAll(hits, target, deadline) {
  const results = new Array(hits.length);
  let next = 0;
  async function worker() {
    while (next < hits.length) {
      const i = next++;
      results[i] = Date.now() > deadline ? { ok: false, reason: 'timeout' } : await checkDecision(hits[i], target);
    }
  }
  await Promise.all([worker(), worker()]);
  return results;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await run(keyword);
  // Windows Node exits with code 127 (libuv assertion) when the runner ends the process right after a fetch;
  // a short pause lets the sockets close first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return result;
}

async function run(keyword) {
  const started = Date.now();
  const name = String(keyword || '').replace(/["“”„]/g, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = `${SEARCH}?${new URLSearchParams({
    lang: 'de', type: 'simple_query', query_words: name, top_subcollection_aza: 'all', from_date: '', to_date: '',
  })}`;
  try {
    if (!words(name).length) return cc('other', 'empty company name', searchUrl);

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return cc('blocked', `HTTP ${res.status}`, searchUrl);
    if (!res.ok) return cc('http_error', `HTTP ${res.status}`, searchUrl);
    const html = await res.text();
    if (looksBlocked(html)) return cc('blocked', 'bot-wall page', searchUrl);

    const exactM = toText(html).match(/(\d[\d']*)\s+exakte Treffer/);
    if (!exactM) {
      if (!/Eurospider|Suchen in|Treffer/.test(html)) return cc('layout_changed', html.slice(0, 300), searchUrl);
      // A normal results page with no exact hit (it may list partial hits only).
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `no exact hit for "${name}"` };
    }
    const exact = parseInt(exactM[1].replace(/'/g, ''), 10);
    if (exact === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `0 exact hits for "${name}"` };
    }

    const hits = parseHits(html).slice(0, MAX_CHECK);
    if (!hits.length) return cc('layout_changed', `${exact} exact hits reported but no result rows found`, searchUrl);

    const target = words(name);
    const checks = await checkAll(hits, target, started + CHECK_DEADLINE_MS);
    const confirmed = checks.filter((c) => c && c.ok).map((c) => c.record);
    if (confirmed.length) {
      return {
        status: 'found', reason: '', records: confirmed, source_url: searchUrl,
        excerpt: `${confirmed.length} of ${hits.length} checked decisions name "${name}" as a party (${exact} exact hits on the site)`,
      };
    }
    const reasons = checks.map((c) => (c && c.reason) || 'other');
    if (reasons.every((r) => r === 'blocked')) return cc('blocked', 'decision pages refused', searchUrl);
    if (reasons.every((r) => r === 'timeout')) return cc('timeout', 'decision pages did not answer in time', searchUrl);
    return cc('other', `${exact} exact hits, but none of the first ${hits.length} decisions names "${name}" as a party`, searchUrl);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return cc(timedOut ? 'timeout' : 'other', String(err?.message || err), searchUrl);
  }
}
