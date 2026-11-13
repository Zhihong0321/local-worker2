export const meta = {
  task: 'CH-jobtic.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'website'],
  canary: { found: 'ALDI SUISSE', not_found: 'Officina Inesistente Ticino Sagl' },
};

// Jobtic's public employer directory: one plain HTML page that lists every employer profile
// (name in the link title, profile URL in href). The profile page gives the employer's website.
const BASE = 'https://www.jobtic.ch';
const INDEX_URL = BASE + '/it/lavoro/aziende';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it,fr,de,en;q=0.7',
};
// The directory shows about 100 employers; fewer than this means the page is not the directory we know.
const MIN_ENTRIES = 20;
// Legal-form words dropped before comparing names (Italian/French/German/English forms used in Switzerland).
const LEGAL = new Set(['ag', 'sa', 'sarl', 'sagl', 'gmbh', 'srl', 'spa', 'ltd', 'llc', 'inc', 'plc', 'kg', 'sas']);

function decode(s) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare form of a company name: case, accents, punctuation and legal form removed. */
function normalise(str) {
  let s = decode(str).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  s = s.replace(/\bs a r l\b/g, 'sarl').replace(/\bs a g l\b/g, 'sagl').replace(/\bs a s\b/g, 'sas').replace(/\bs a\b/g, 'sa');
  return s.split(' ').filter((t) => t && !LEGAL.has(t)).join(' ');
}

/** Every employer link on the directory page: { name, url }, one per profile URL. */
function parseEntries(html) {
  const byUrl = new Map();
  const tags = html.match(/<a\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const t = tag.match(/\btitle="Visitare il profilo di ([^"]*)"/i);
    const h = tag.match(/\bhref="([^"]+)"/i);
    if (!t || !h) continue;
    const url = new URL(decode(h[1]), BASE).href;
    if (!byUrl.has(url)) byUrl.set(url, { name: decode(t[1]), url });
  }
  return [...byUrl.values()];
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = normalise(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX_URL,
        excerpt: 'the name has no words left after removing the legal form' };
    }

    const res = await fetch(INDEX_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: INDEX_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: INDEX_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const entries = parseEntries(html);
    if (entries.length < MIN_ENTRIES) {
      if (/captcha|cf-chl|just a moment|are you a robot/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: INDEX_URL, excerpt: 'bot check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: INDEX_URL,
        excerpt: `directory page has ${entries.length} employer links, expected at least ${MIN_ENTRIES}` };
    }

    const matches = entries.filter((e) => normalise(e.name) === key);
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: INDEX_URL,
        excerpt: `no employer named "${keyword}" in the Jobtic employer directory (${entries.length} entries)` };
    }

    // Enrich the first match with its profile page (website). Optional: on failure keep the directory data.
    const records = matches.map((m) => ({ name: m.name, profile_url: m.url, website: '' }));
    try {
      const pr = await fetch(matches[0].url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (pr.ok) {
        const ph = await pr.text();
        const w = ph.match(/<a href="([^"]+)" title="Visita il sito di/i);
        if (w) records[0].website = new URL(decode(w[1]), BASE).href;
      }
    } catch (e) {
      // profile page unavailable: the directory entry alone still proves the company is listed
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].url,
      excerpt: matches.map((m) => `Visitare il profilo di ${m.name}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: INDEX_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
