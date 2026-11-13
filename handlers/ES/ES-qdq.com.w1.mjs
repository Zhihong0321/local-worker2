export const meta = {
  task: 'ES-qdq.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'telephone', 'postal_code', 'locality', 'profile_url'],
  canary: { found: 'AUDIO VIDEO TEST, S.L.', not_found: 'Zqxvbn Inexistente S.L.' },
};

const SITE = 'https://www.qdq.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};
// Spanish legal forms (compared without dots, accents or case). Only trailing ones are dropped.
const LEGAL = new Set(['sl', 'slu', 'sa', 'sau', 'slp', 'sll', 'slne', 'scp', 'sc', 'sccl', 'coop', 'cb', 'sociedad', 'limitada', 'anonima', 'unipersonal', 'ltd', 'llc', 'inc', 'gmbh', 'sdn', 'bhd']);
const PAGE_SIZE = 12;   // the site shows 12 companies per result page
const MAX_PAGES = 3;    // 36 results at most per query
const BUDGET_MS = 30000; // stop starting new requests after 30 s (the whole call must end under 60 s)

/** Splits a company name into comparable pieces: accents, case, dots and punctuation removed. */
function splitName(text) {
  return String(text || '').replace(/,/g, ' ').split(/\s+/).filter(Boolean)
    .map((raw) => ({ raw, key: raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') }))
    .filter((p) => p.key);
}

/** Drops the legal form from the end of the name ("S.L.", "SL", "S. L.", "SDN BHD" ...). */
function trimLegal(pieces) {
  const out = pieces.slice();
  let changed = true;
  while (changed && out.length) {
    changed = false;
    if (LEGAL.has(out[out.length - 1].key)) { out.pop(); changed = true; }
    else if (out.length >= 2 && LEGAL.has(out[out.length - 2].key + out[out.length - 1].key)) { out.splice(-2); changed = true; }
  }
  return out;
}

/** Normalised comparison key: "AUDIO VIDEO TEST, S.L." and "Audio Video Test SL" give the same key. */
function nameKey(text) {
  return trimLegal(splitName(text)).map((p) => p.key).join(' ');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Company cards of one result page: { href, name, address }. */
function parseCards(html) {
  const cards = [];
  const re = /<a href="([^"]+)"[^>]*class="business-card-link"([\s\S]*?)(?=<a href="[^"]+"[^>]*class="business-card-link"|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = m[2];
    const title = body.match(/<h2 class="business-title"[^>]*>([\s\S]*?)<\/h2>/);
    const addr = body.match(/<span class="business-address"[^>]*>([\s\S]*?)<\/span>/);
    if (!title) continue;
    cards.push({
      href: decodeEntities(m[1]),
      name: decodeEntities(title[1].replace(/<[^>]+>/g, ' ')),
      address: decodeEntities(addr ? addr[1].replace(/<[^>]+>/g, ' ') : ''),
    });
  }
  return cards;
}

/** Trailing legal form removed from the typed name, keeping the user's own spelling for the site search. */
function nameWithoutLegal(text) {
  const raw = String(text || '').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  let end = raw.length;
  const keyOf = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let changed = true;
  while (changed && end > 0) {
    changed = false;
    if (LEGAL.has(keyOf(raw[end - 1]))) { end -= 1; changed = true; }
    else if (end >= 2 && LEGAL.has(keyOf(raw[end - 2]) + keyOf(raw[end - 1]))) { end -= 2; changed = true; }
  }
  return raw.slice(0, end).join(' ');
}

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const wanted = nameKey(kw);
  const searchUrlFor = (q, pg) => `${SITE}/search?searchpage=company&q=${encodeURIComponent(q)}&pg=${pg}`;
  if (!wanted) return out('couldnt_check', 'other', searchUrlFor(kw, 1), 'the name has no letters or digits');

  try {
    // First the name as typed (legal form included), then the same name without the legal form.
    const queries = [kw];
    const bare = nameWithoutLegal(kw);
    if (bare && bare !== kw) queries.push(bare);

    let answered = 0; // queries whose first result page answered normally
    let truncated = '';
    let lastUrl = searchUrlFor(kw, 1);
    const matches = [];
    const seen = new Set();

    for (const q of queries) {
      let queryAnswered = false;
      for (let pg = 1; pg <= MAX_PAGES; pg++) {
        if (Date.now() - started > BUDGET_MS) {
          return out('couldnt_check', 'timeout', lastUrl, 'stopped after 30 s to stay under the 60 s limit');
        }
        const url = searchUrlFor(q, pg);
        lastUrl = url;
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', url, `HTTP ${res.status}`);
        if (!res.ok) return out('couldnt_check', 'http_error', url, `HTTP ${res.status}`);
        const html = await res.text();

        const cards = parseCards(html);
        const noResults = html.includes('No tenemos resultados');
        if (!cards.length && !noResults) {
          if (/captcha|Just a moment|challenge-platform|cf-chl/i.test(html)) return out('couldnt_check', 'blocked', url, 'bot check page');
          return out('couldnt_check', 'layout_changed', url, html.slice(0, 300));
        }
        if (!queryAnswered) { queryAnswered = true; answered += 1; }

        for (const c of cards) {
          if (nameKey(c.name) === wanted && !seen.has(c.href)) {
            seen.add(c.href);
            matches.push({ ...c, search_url: url });
          }
        }
        if (cards.length < PAGE_SIZE) break; // last page of this query
        if (pg === MAX_PAGES) truncated = url;
      }
      if (matches.length) break;
    }

    if (matches.length) {
      const records = [];
      for (const c of matches.slice(0, 5)) {
        const profile_url = new URL(c.href, SITE).href;
        const rec = { name: c.name, address: c.address, telephone: '', postal_code: '', locality: '', profile_url };
        if (Date.now() - started < BUDGET_MS) {
          try {
            const r = await fetch(profile_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
            if (r.ok) {
              const page = await r.text();
              for (const block of page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
                let data = null;
                try { data = JSON.parse(block[1]); } catch { data = null; }
                if (data && data['@type'] === 'LocalBusiness') {
                  rec.telephone = data.telephone || '';
                  rec.postal_code = data.address?.postalCode || '';
                  rec.locality = data.address?.addressLocality || '';
                  break;
                }
              }
            }
          } catch { /* the search card already gives the name and address */ }
        }
        records.push(rec);
      }
      return {
        status: 'found',
        reason: '',
        records,
        source_url: matches[0].search_url,
        excerpt: `${matches.length} exact match(es) for "${kw}": ${matches.map((m) => m.name).join(' | ')}`.slice(0, 500),
      };
    }

    if (truncated) {
      return out('couldnt_check', 'other', truncated, `more than ${MAX_PAGES * PAGE_SIZE} results for the search and none matched exactly; the rest were not read`);
    }
    if (answered === queries.length) {
      return out('not_found', '', searchUrlFor(kw, 1), `the search answered normally with no exact match for "${kw}"`);
    }
    return out('couldnt_check', 'other', lastUrl, 'the search did not complete');
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return out('couldnt_check', timeout ? 'timeout' : 'other', searchUrlFor(kw, 1), String(err?.message || err));
  }
}
