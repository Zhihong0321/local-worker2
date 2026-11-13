export const meta = { task: 'NL-officielebekendmakingen.nl', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'kvk', 'doc_title', 'publication_date', 'doc_url'],
  canary: { found: 'Shami Transport B.V', not_found: 'Zzqxvnbv Holding B.V.' } };

// Officiële Bekendmakingen full-text search (GET). Company names appear inside notices (bankruptcies, liquidations,
// mergers...), so the handler searches, opens the matching notices and checks the company name in their text.
const BASE = 'https://zoek.officielebekendmakingen.nl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5' };
const MAX_CANDIDATES = 40;   // notices opened per lookup
const BATCH = 5;             // notices fetched at a time
const NO_NEW_BATCH_AFTER_MS = 25000;

// Legal-form endings, stripped from the end of the typed name before matching ("B.V.", "N.V.", "BHD" ...).
const LEGAL_SUFFIXES = [['b', 'v', 'b', 'a'], ['n', 'v', 't'], ['b', 'v', 'i'], ['v', 'o', 'f'], ['sdn', 'bhd'],
  ['b', 'v'], ['n', 'v'], ['c', 'v'], ['bv'], ['nv'], ['cv'], ['vof'], ['gmbh'], ['ltd'], ['bhd'], ['inc'], ['llc'], ['plc']];
// Words that may follow a company name in a notice ("Zorgplan B.V, corr.adr. ...", "... KvK: ...", "... hodn ...").
const STOP = new Set(['kvk', 'vest', 'corr', 'adr', 'hodn', 'cur', 'rc', 'geb', 'woonadr', 'gevestigd', 'te', 'in',
  'onder', 'hierna', 'voorheen', 'statutair', 'handelend', 'handelsnaam', 'postbus', 'nr', 'tel', 'liquidatie',
  'faillissement', 'surseance', 'ten']);

function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function htmlToText(html) {
  return decodeEntities((html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Lowercase, accents removed, '&' read as 'en', only letters and digits kept.
function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' en ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(s) { return norm(s).split(' ').filter(Boolean); }

function stripLegal(t) {
  let out = t.slice();
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (out.length > suf.length && suf.every((x, i) => out[out.length - suf.length + i] === x)) {
        out = out.slice(0, out.length - suf.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function classifyError(e) {
  const n = e && e.name;
  return (n === 'TimeoutError' || n === 'AbortError') ? 'timeout' : 'other';
}

async function getText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const body = await res.text();
  return { status: res.status, ok: res.ok, body, url: res.url || url };
}

function parseSearch(html) {
  const text = htmlToText(html);
  if (/Geen resultaten gevonden/i.test(text)) return { total: 0, hits: [] };
  const m = text.match(/van de\s+([\d.]+)\s+resultaten/i);
  if (!m) return null;
  const total = parseInt(m[1].replace(/\./g, ''), 10);
  const hits = [];
  const re = /class="result--title "><a href="([^"]+)"/g;
  let x;
  while ((x = re.exec(html))) hits.push(new URL(x[1], BASE).href);
  if (total > 0 && hits.length === 0) return null;
  return { total, hits };
}

function searchUrl(zv) {
  return `${BASE}/resultaten?zv=${encodeURIComponent(zv)}&pg=50&col=`;
}

async function runSearch(url) {
  try {
    const r = await getText(url);
    if (r.status === 403 || r.status === 429) return { kind: 'fail', reason: 'blocked', url, excerpt: `HTTP ${r.status}` };
    if (!r.ok) return { kind: 'fail', reason: 'http_error', url, excerpt: `HTTP ${r.status}` };
    const parsed = parseSearch(r.body);
    if (!parsed) {
      const text = htmlToText(r.body);
      if (/captcha|robot|toegang geweigerd|access denied/i.test(text)) return { kind: 'fail', reason: 'blocked', url, excerpt: text.slice(0, 200) };
      return { kind: 'fail', reason: 'layout_changed', url, excerpt: text.slice(0, 300) };
    }
    return { kind: 'ok', url, total: parsed.total, hits: parsed.hits };
  } catch (e) {
    return { kind: 'fail', reason: classifyError(e), url, excerpt: String(e?.message || e).slice(0, 200) };
  }
}

async function runDoc(url) {
  try {
    const r = await getText(url);
    if (r.status === 403 || r.status === 429) return { kind: 'fail', reason: 'blocked', url, excerpt: `HTTP ${r.status}` };
    if (!r.ok) return { kind: 'fail', reason: 'http_error', url, excerpt: `HTTP ${r.status}` };
    const h1 = r.body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const published = r.body.match(/<time datetime="([^"]+)"/i);
    return { kind: 'ok', url: r.url, text: htmlToText(r.body), title: h1 ? htmlToText(h1[1]) : '',
      published: published ? published[1] : '' };
  } catch (e) {
    return { kind: 'fail', reason: classifyError(e), url, excerpt: String(e?.message || e).slice(0, 200) };
  }
}

// Finds the company (core tokens, contiguous, legal form optional) in a notice's text.
// It must not be followed by another name word ("Zorgplan Nederland Solar" is not "Zorgplan Nederland").
function matchNotice(text, core) {
  const T = tokens(text);
  for (let i = 0; i + core.length <= T.length; i++) {
    if (T[i] !== core[0]) continue;
    if (!core.every((c, j) => T[i + j] === c)) continue;
    let k = i + core.length;
    let skipped = true;
    while (skipped) {
      skipped = false;
      for (const suf of LEGAL_SUFFIXES) {
        if (suf.every((x, n) => T[k + n] === x)) { k += suf.length; skipped = true; break; }
      }
    }
    const next = T[k];
    if (next === undefined || STOP.has(next) || /^\d/.test(next)) {
      let kvk = '';
      for (let q = i; q < Math.min(T.length - 1, i + 60); q++) {
        if (T[q] === 'kvk' && /^\d{8}$/.test(T[q + 1])) { kvk = T[q + 1]; break; }
      }
      return { name: T.slice(i, k).join(' '), kvk, snippet: T.slice(Math.max(0, i - 8), k + 20).join(' ') };
    }
  }
  return null;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const core = stripLegal(tokens(keyword));
    if (core.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty company name' };
    }
    // "en" (from "&") is left out of the search only; matching still uses it.
    const terms = core.filter((t) => t !== 'en');
    const phraseUrl = searchUrl(`"${terms.join(' ')}"`);
    const andUrl = searchUrl(terms.join(' '));

    // One request after the other (not in parallel): fewer requests at once, and it keeps the worker process exiting cleanly.
    const ph = await runSearch(phraseUrl);
    const an = await runSearch(andUrl);
    if (ph.kind === 'fail' && an.kind === 'fail') {
      return { status: 'couldnt_check', reason: ph.reason, records: [], source_url: ph.url, excerpt: ph.excerpt };
    }

    const seen = new Set();
    const candidates = [];
    for (const s of [ph, an]) {
      if (s.kind !== 'ok') continue;
      for (const h of s.hits) {
        if (!seen.has(h) && candidates.length < MAX_CANDIDATES) { seen.add(h); candidates.push(h); }
      }
    }

    const records = [];
    const matchedSnippets = [];
    let failure = null;
    let processed = 0;
    while (processed < candidates.length && Date.now() - started < NO_NEW_BATCH_AFTER_MS) {
      const batch = candidates.slice(processed, processed + BATCH);
      const docs = await Promise.all(batch.map(runDoc));
      processed += batch.length;
      for (const d of docs) {
        if (d.kind === 'fail') { if (!failure) failure = d; continue; }
        const m = matchNotice(d.text, core);
        if (m) {
          records.push({ name: m.name, kvk: m.kvk, doc_title: d.title, publication_date: d.published, doc_url: d.url });
          matchedSnippets.push(m.snippet);
        }
      }
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: phraseUrl,
        excerpt: matchedSnippets.slice(0, 3).join(' | ').slice(0, 500) };
    }
    if (failure) {
      return { status: 'couldnt_check', reason: failure.reason, records: [], source_url: failure.url, excerpt: failure.excerpt };
    }
    // Complete only if the exact-phrase search was fully loaded and every notice it returned was read.
    // (The word search only adds candidates; its size does not block a not_found.)
    const complete = ph.kind === 'ok' && ph.total <= ph.hits.length && ph.hits.length <= MAX_CANDIDATES && processed >= ph.hits.length;
    if (!complete) {
      const totals = [ph, an].map((s) => (s.kind === 'ok' ? s.total : 'failed')).join(' / ');
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: phraseUrl,
        excerpt: `too many search results to check all (phrase / word search totals: ${totals}; read ${processed} of ${candidates.length} notices)` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: phraseUrl,
      excerpt: `0 notices contain "${core.join(' ')}" (phrase search: ${ph.total}, word search: ${an.total})` };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
