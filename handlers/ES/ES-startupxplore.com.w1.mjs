export const meta = { task: 'ES-startupxplore.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'type', 'url', 'countries', 'offices', 'description'],
  canary: { found: 'AUNOA', not_found: 'Empresa Inexistente Zzqx S.L.' } };

const SITE = 'https://startupxplore.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HITS_PER_PAGE = 100;
const MAX_PAGES = 5;

// Legal-form endings, removed from the END of a name only (after lowercasing and removing accents/punctuation).
const LEGAL_TAIL = /(?:^| )(sociedad limitada unipersonal|sociedad limitada|sociedad anonima|sociedad cooperativa|s l u|s l l|s l|s a u|s a|slu|sll|sl|sau|sa|scp|ltd|limited|llc|inc|gmbh|sas|srl|sarl|bv|plc|corp|corporation|sdn bhd|pte ltd|pvt ltd)$/;

function spaced(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Comparison key: lowercase, no accents, no punctuation, no spaces, legal form removed. */
function matchKey(s) {
  let t = spaced(s);
  let stripped = t;
  while (LEGAL_TAIL.test(stripped)) stripped = stripped.replace(LEGAL_TAIL, '').trim();
  return (stripped || t).replace(/ /g, '');
}

function fetchOpts(extra) {
  return { ...extra, headers: { 'User-Agent': UA, ...(extra && extra.headers) }, signal: AbortSignal.timeout(25000) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '');
  const pageUrl = `${SITE}/en/search?q=${encodeURIComponent(kw)}`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: pageUrl, excerpt: String(excerpt || '').slice(0, 300) });
  try {
    // 1. The search page embeds the public search-only key the site itself uses for its search box.
    const pageRes = await fetch(pageUrl, fetchOpts({ headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' } }));
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return fail('http_error', `HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    const keys = html.match(/user:\s*"([A-Za-z0-9]{6,})",\s*public:\s*"([A-Za-z0-9]{16,})"/);
    if (!keys) {
      if (/captcha|cf-chl|verify you are human|access denied/i.test(html)) return fail('blocked', html.slice(0, 300));
      return fail('layout_changed', html.slice(0, 300));
    }
    const [, appId, apiKey] = keys;

    // 2. Ask the same search index the site's search box uses. The site's own query is a free-text query.
    const query = spaced(kw) || kw.trim();
    const key = matchKey(kw);
    if (!key) return fail('other', 'empty company name');
    const searchUrl = `https://${appId}-dsn.algolia.net/1/indexes/profiles/query`;
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Algolia-Application-Id': appId,
      'X-Algolia-API-Key': apiKey, 'Origin': SITE, 'Referer': pageUrl };

    let nbHits = 0;
    let nbPages = 0;
    const matches = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(searchUrl, fetchOpts({ method: 'POST', headers,
        body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=${HITS_PER_PAGE}&page=${page}` }) }));
      if (res.status === 403 || res.status === 429) return fail('blocked', `search HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', `search HTTP ${res.status}`);
      let json;
      try { json = await res.json(); } catch (e) { return fail('layout_changed', 'search reply is not JSON'); }
      if (!json || !Array.isArray(json.hits)) return fail('layout_changed', 'search reply has no hits list');
      nbHits = Number(json.nbHits) || 0;
      nbPages = Number(json.nbPages) || 0;
      for (const h of json.hits) {
        if (!h || !h.name || matchKey(h.name) !== key) continue;
        const countries = [...new Set((h.locationTags || []).map((l) => l && l.country).filter(Boolean))];
        const offices = (h.offices || []).map((o) => o && o.address).filter(Boolean);
        matches.push({
          name: h.name,
          type: h.tag || '',
          url: h.url_en ? new URL(h.url_en, SITE).href : (h.url ? new URL(h.url, SITE).href : ''),
          countries,
          offices,
          description: String(h.description || '').slice(0, 300),
        });
      }
      if (matches.length) break;
      if (page + 1 >= nbPages) break;
    }

    if (matches.length) {
      const first = matches[0];
      return { status: 'found', reason: '', records: matches, source_url: pageUrl,
        excerpt: `${first.name} (${first.type}) ${first.url} ${first.countries.join(', ')}`.slice(0, 300) };
    }
    if (nbPages > MAX_PAGES) {
      return fail('other', `search returned ${nbHits} hits; only the first ${MAX_PAGES * HITS_PER_PAGE} were checked`);
    }
    return { status: 'not_found', reason: '', records: [], source_url: pageUrl,
      excerpt: `Search for "${kw}" returned ${nbHits} hits, none with the same name` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', String(err?.message || err));
  }
}
