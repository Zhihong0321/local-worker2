export const meta = {
  task: 'PH-businesslist.ph',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'url', 'address', 'city', 'tagline', 'phone', 'established', 'years_in_business', 'verified'],
  canary: { found: 'Save Money Trading Inc.', not_found: 'Tindahan ng Hindi Umiiral Kooperatiba' },
};

const SITE = 'https://www.businesslist.ph';
const SEARCH_PATH = '/philippines-business-search';
const SEARCH_URL = SITE + SEARCH_PATH;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words and their canonical form. "SDN BHD" is two words, handled in parseName.
const LEGAL_FORMS = { inc: 'inc', incorporated: 'inc', corp: 'corp', corporation: 'corp', co: 'co', company: 'co',
  ltd: 'ltd', limited: 'ltd', llc: 'llc', opc: 'opc', plc: 'plc', lp: 'lp', llp: 'llp' };
const BLOCKED_MARKERS = ['just a moment', 'cf-chl', 'captcha', 'access denied', 'attention required'];

/** Lower-case, strip accents and punctuation. Returns the name without legal form ("core") and its legal forms. */
function parseName(str) {
  const words = (str || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/).filter(Boolean);
  const core = [];
  const forms = new Set();
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 'sdn' && words[i + 1] === 'bhd') { forms.add('sdnbhd'); i++; continue; }
    if (words[i] === 'pte' && words[i + 1] === 'ltd') { forms.add('ltd'); i++; continue; }
    if (LEGAL_FORMS[words[i]]) { forms.add(LEGAL_FORMS[words[i]]); continue; }
    core.push(words[i]);
  }
  return { core: core.join(''), forms: [...forms].sort().join('+') };
}

/** Same name: same words once the legal form is set aside. Different legal forms (INC vs CORP) are different companies. */
function sameCompany(keyword, listed) {
  const k = parseName(keyword);
  const n = parseName(listed);
  if (!k.core || k.core !== n.core) return false;
  return !k.forms || !n.forms || k.forms === n.forms;
}

function decode(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function pick(block, re) {
  const m = block.match(re);
  return m ? decode(m[1]) : '';
}

/** Read the result cards on a search results page. */
function parseCards(html) {
  const starts = [...html.matchAll(/<div class="company[^"]*"[^>]*data-cmpid="(\d+)"/g)];
  return starts.map((m, i) => {
    const block = html.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const link = block.match(/<h3><a href="(\/company\/\d+\/[^"]*)"[^>]*>([\s\S]*?)<\/a><\/h3>/);
    return {
      company_id: m[1],
      name: link ? decode(link[2]) : '',
      url: link ? SITE + link[1] : '',
      address: pick(block, /<div class="address">([\s\S]*?)<\/div>/),
      city: pick(block, /<div class="address">[\s\S]*?<b>([\s\S]*?)<\/b>/),
      tagline: pick(block, /<div class="tagline">[\s\S]*?<\/i>([\s\S]*?)<\/div>/),
      phone: pick(block, /fa-phone"[^>]*>\s*<\/i>\s*<span><b>([^<]*)<\/b>/),
      established: pick(block, /fa-calendar[\s\S]*?<span>([\s\S]*?)<\/span>/),
      years_in_business: pick(block, /<b>\+?([\d]+)<\/b>[^<]*(?:&nbsp;|\s)*Years in business/i),
      verified: /fa-check-circle/.test(block) ? 'Verified' : '',
    };
  }).filter((c) => c.name);
}

/** One search: a session cookie from the home page, the form POST, then the results page. */
async function search(query) {
  const home = await fetch(SITE + '/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (home.status === 403 || home.status === 429) return { blocked: home.status };
  const cookie = (home.headers.get('set-cookie') || '').match(/CAKEPHP=[^;]+/)?.[0] || '';
  await home.arrayBuffer();

  const body = new URLSearchParams({
    _method: 'POST',
    'data[CompanySearch][query]': query,
    'data[CompanySearch][location]': '',
  });
  const headers = { 'User-Agent': UA, 'Referer': SITE + '/', 'Origin': SITE, 'Cookie': cookie,
    'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' };
  const post = await fetch(SEARCH_URL, {
    method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(25000),
  });
  if (post.status === 403 || post.status === 429) { await post.arrayBuffer(); return { blocked: post.status }; }
  await post.arrayBuffer();

  // The site answers the POST with a redirect back to the results page; the query lives in the session.
  const res = await fetch(SEARCH_URL, {
    headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Cookie': cookie, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) { await res.arrayBuffer(); return { blocked: res.status }; }
  if (!res.ok) { await res.arrayBuffer(); return { httpError: res.status }; }
  const html = await res.text();
  const lower = html.slice(0, 20000).toLowerCase();
  if (BLOCKED_MARKERS.some((k) => lower.includes(k))) return { blocked: 'challenge' };

  const empty = html.includes('There are no results matching your query');
  const cards = parseCards(html);
  if (!empty && !cards.length) return { layout: html.slice(0, 300) };
  return { cards, empty };
}

function matchesFor(keyword, cards) {
  return cards.filter((c) => sameCompany(keyword, c.name));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const text = String(keyword || '').replace(/\s+/g, ' ').trim();
  const core = text.replace(/[.,]/g, ' ').split(' ')
    .filter((w) => !LEGAL_FORMS[w.toLowerCase()] && !['sdn', 'bhd', 'pte'].includes(w.toLowerCase())).join(' ').trim();
  const queries = [];
  if (text) queries.push(text.length > 40 ? core.slice(0, 40) : text);
  if (core && core.length >= 3 && core !== queries[0]) queries.push(core.slice(0, 40));
  try {
    if (!queries.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH_URL, excerpt: 'empty keyword' };
    }
    let lastEmpty = false;
    for (let i = 0; i < queries.length; i++) {
      if (i > 0 && Date.now() - started > 30000) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: SEARCH_URL,
          excerpt: 'the first search did not settle the answer in time for a second try' };
      }
      const r = await search(queries[i]);
      if (r.blocked) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${r.blocked}` };
      }
      if (r.httpError) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${r.httpError}` };
      }
      if (r.layout) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_URL, excerpt: r.layout };
      }
      const hits = matchesFor(text, r.cards);
      if (hits.length) {
        return {
          status: 'found', reason: '', records: hits.map(({ name, company_id, url, address, city, tagline, phone,
            established, years_in_business, verified }) => ({ name, company_id, url, address, city, tagline, phone,
            established, years_in_business, verified })),
          source_url: SEARCH_URL,
          excerpt: hits.map((h) => `${h.name} | ${h.address}`).join(' ; ').slice(0, 500),
        };
      }
      lastEmpty = r.empty;
    }
    if (lastEmpty) {
      return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `"There are no results matching your query." for ${text}` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
      excerpt: `results for ${text} listed no company with this name` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: SEARCH_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
