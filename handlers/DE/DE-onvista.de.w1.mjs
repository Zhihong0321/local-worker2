export const meta = {
  task: 'DE-onvista.de',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'entity_type', 'display_type', 'isin', 'wkn', 'symbol', 'onvista_id', 'url'],
  canary: { found: 'Siemens', not_found: 'Xanthophyllwerk Musterfirma GmbH' },
};

// Onvista's own public instrument search (the JSON call the search box makes). No login, no key.
// It returns at most 10 hits per query, mixed across stocks, bonds, funds and futures.
const API = 'https://api.onvista.de/api/v1/instruments/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_HITS = 10;

// Legal-form words, stripped from the end of a name before comparing.
const LEGAL = new Set(['ag', 'se', 'gmbh', 'kgaa', 'kg', 'co', 'ohg', 'ug', 'mbh', 'plc', 'inc', 'ltd', 'limited',
  'corp', 'sa', 'nv', 'bv', 'spa', 'srl', 'ab', 'asa', 'oyj', 'llc', 'lp', 'bhd', 'sdn']);
// Share-class words on a stock name, e.g. "Volkswagen (VW) Vz".
const SHARE_CLASS = new Set(['vz', 'st', 'vorzug', 'stamm', 'vorzugsaktie', 'stammaktie']);

/** Lower case, German letters folded (ä→ae, ß→ss), accents removed, punctuation to spaces. */
function fold(str) {
  return String(str || '')
    .replace(/ß/g, 'ss')
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(str) {
  const t = fold(str);
  return t ? t.split(' ') : [];
}

function stripLegal(toks) {
  const out = [...toks];
  while (out.length > 1 && LEGAL.has(out[out.length - 1])) out.pop();
  return out;
}

/** A stock record matches when its name, minus brackets and share-class words, equals the company core name. */
function stockMatches(name, coreToks) {
  const t = tokens(String(name || '').replace(/\([^)]*\)/g, ' '));
  while (t.length > 1 && SHARE_CLASS.has(t[t.length - 1])) t.pop();
  return stripLegal(t).join(' ') === coreToks.join(' ');
}

/** A bond record matches when its name starts with the core name and a legal form word comes right after it
 *  (e.g. "Allianz SE FLR-Sub..." for "Allianz"). "Volkswagen Leasing GmbH ..." does not match "Volkswagen". */
function bondMatches(name, coreToks) {
  const t = tokens(name);
  for (let i = 0; i < coreToks.length; i++) {
    if (t[i] !== coreToks[i]) return false;
  }
  return LEGAL.has(t[coreToks.length]);
}

function matches(entry, coreToks) {
  if (entry.entityType === 'STOCK') return stockMatches(entry.name, coreToks);
  if (entry.entityType === 'BOND') return bondMatches(entry.name, coreToks);
  return false; // funds, futures and other instruments are not company records
}

function toRecord(e) {
  return {
    name: e.name || '',
    entity_type: e.entityType || '',
    display_type: e.displayType || '',
    isin: e.isin || '',
    wkn: e.wkn || '',
    symbol: e.symbol || '',
    onvista_id: e.entityValue != null ? String(e.entityValue) : '',
    url: (e.urls && e.urls.WEBSITE) || '',
  };
}

/** One search request. Returns { url, list } on a normal answer, or { url, fail } with a couldnt_check reason. */
async function askSite(term) {
  const url = `${API}?searchValue=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { url, fail: { reason: 'blocked', excerpt: `HTTP ${res.status}` } };
    }
    if (!res.ok) {
      return { url, fail: { reason: 'http_error', excerpt: `HTTP ${res.status}` } };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json || !Array.isArray(json.list)) {
      if (/captcha|cloudflare|access denied|are you a robot/i.test(text.slice(0, 3000))) {
        return { url, fail: { reason: 'blocked', excerpt: text.slice(0, 300) } };
      }
      return { url, fail: { reason: 'layout_changed', excerpt: text.slice(0, 300) } };
    }
    return { url, list: json.list };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { url, fail: { reason: timedOut ? 'timeout' : 'other', excerpt: String(err?.message || err).slice(0, 300) } };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Let the HTTP sockets finish closing before the runner exits (Node on Windows can abort on exit otherwise).
  await new Promise(resolve => setTimeout(resolve, 500));
  return answer;
}

async function search(keyword) {
  try {
    const name = String(keyword || '').trim();
    const allToks = tokens(name);
    const coreToks = stripLegal(allToks);
    if (!coreToks.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    // Query 1: the core name without legal form (so futures and funds do not crowd out the company).
    // Query 2: the name as typed, only when it differs (catches issuer bonds written with their legal form).
    const terms = [coreToks.join(' ')];
    if (name && allToks.join(' ') !== terms[0]) terms.push(name);

    const answers = await Promise.all(terms.map(askSite));

    const records = [];
    const seen = new Set();
    let sourceUrl = '';
    for (const a of answers) {
      if (!a.list) continue;
      for (const e of a.list) {
        if (!e || typeof e !== 'object' || !matches(e, coreToks)) continue;
        const key = `${e.entityType}|${e.entityValue ?? e.isin ?? e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!sourceUrl) sourceUrl = a.url;
        records.push(toRecord(e));
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: sourceUrl,
        excerpt: records.slice(0, 3).map(r => `${r.name} (${r.entity_type}, ISIN ${r.isin || '-'})`).join('; ').slice(0, 500),
      };
    }

    // No match. A site refusal or a failed answer is never "not found".
    const bad = answers.find(a => a.fail);
    if (bad) {
      return { status: 'couldnt_check', reason: bad.fail.reason, records: [], source_url: bad.url, excerpt: bad.fail.excerpt };
    }
    // The site returns at most 10 hits; if a list is full, the company may simply be beyond the cut-off.
    const capped = answers.find(a => a.list && a.list.length >= MAX_HITS);
    if (capped) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: capped.url,
        excerpt: `search returned ${MAX_HITS} hits (the site's cap) and none matched "${coreToks.join(' ')}"`,
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: answers[0].url,
      excerpt: `0 matching company records for "${coreToks.join(' ')}" (${answers.map(a => a.list.length).join(' + ')} hits, none matched)`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: '',
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
