export const meta = { task: 'IN-icra.in', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'company_id', 'matched_on', 'ratings', 'latest_rationale', 'page_url'],
  canary: { found: 'Jubilant Pharmova Limited', not_found: 'रामप्रसाद अज्ञात प्राइवेट लिमिटेड' } };

// ICRA's header search ("Search by entity") calls POST /Rating/GetRatingCompanys with Term=<text>.
// It answers a JSON list [{ id, label }] (empty list = no match). Each id opens the public
// /Rating/RatingDetails page, which holds the instrument ratings in a plain HTML table.

const BASE = 'https://www.icra.in';
const SEARCH_URL = `${BASE}/Rating/GetRatingCompanys`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LEGAL = new Set(['LIMITED', 'LTD', 'PRIVATE', 'PVT', 'PRIV', 'PUBLIC', 'PLC', 'LLP', 'INC', 'CO', 'COMPANY', 'CORPORATION', 'CORP', 'OPC']);
const FORMER = /\(\s*(?:erstwhile|formerly|earlier|previously)\s+([^)]+)\)/i;

/** Upper-case words, keeping letters in any script; '&' becomes AND. */
function words(s) {
  return String(s || '').toUpperCase().replace(/&/g, ' AND ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Normalised name: no punctuation, no trailing legal form (PRIVATE LIMITED, LTD, ...). */
function core(s) {
  const w = words(s);
  while (w.length && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** What we send to the site: the name as typed, minus a trailing legal form. */
function searchTerm(keyword) {
  const parts = String(keyword).trim().split(/\s+/);
  while (parts.length) {
    const w = words(parts[parts.length - 1]);
    if (w.length === 1 && LEGAL.has(w[0])) parts.pop(); else break;
  }
  return parts.join(' ') || String(keyword).trim();
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&rsquo;|&#8217;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

function failReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

function fail(reason, excerpt, source_url = SEARCH_URL) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** One company page: instrument ratings and latest rationale. Never throws. */
async function detail(hit) {
  const url = `${BASE}/Rating/RatingDetails?CompanyId=${hit.id}&CompanyName=${encodeURIComponent(hit.label)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: 'blocked', url, excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { fail: 'http_error', url, excerpt: `HTTP ${res.status}` };
    const html = await res.text();

    const table = html.match(/<thead[^>]*>[\s\S]*?<th[^>]*>\s*Instrument\s*<\/th>[\s\S]*?<\/thead>\s*<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!table) return { fail: 'layout_changed', url, excerpt: clean(html).slice(0, 300) };

    const ratings = [];
    for (const row of table[1].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(clean);
      if (cells.length >= 2 && cells[0]) ratings.push({ instrument: cells[0], rating: cells[1] });
    }

    const nameMatch = html.match(new RegExp(`"CompanyId":${hit.id},"CompanyName":"([^"]+)"`));
    const name = nameMatch ? nameMatch[1] : hit.label;

    let latest = null;
    const rat = html.match(/var Entity_Specific_Rational\s*=\s*(\[[\s\S]*?\]);/);
    if (rat) {
      try {
        const first = JSON.parse(rat[1]).find(r => String(r.CompanyId) === String(hit.id));
        if (first) latest = { title: first.RationaleTitle || '', date: first.RationalDateString || first.RationalDate || '' };
      } catch { /* rationale list not readable: leave it out */ }
    }

    return {
      record: { name, company_id: hit.id, matched_on: hit.matched_on, ratings, latest_rationale: latest, page_url: url },
      url,
      excerpt: ratings.map(r => `${r.instrument}: ${r.rating}`).join('; ') || (latest ? latest.title : ''),
    };
  } catch (err) {
    return { fail: failReason(err), url, excerpt: String(err?.message || err) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows aborts (exit 127, after the answer is printed) when the runner calls process.exit()
  // straight after a fetch. A short pause lets the connection settle first. Costs 250 ms.
  await new Promise(r => setTimeout(r, 250));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', 'empty company name');
    const want = core(name);
    if (!want) return fail('other', 'nothing left of the name after removing the legal form');
    const term = searchTerm(name);

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': BASE,
        'Referer': `${BASE}/`,
      },
      body: new URLSearchParams({ Term: term }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const text = await res.text();
    if (!text.trim().startsWith('[') && /captcha|request unsuccessful|access denied/i.test(text)) {
      return fail('blocked', clean(text).slice(0, 300));
    }
    let list;
    try { list = JSON.parse(text); } catch { return fail('layout_changed', clean(text).slice(0, 300)); }
    if (!Array.isArray(list) || list.some(x => !x || typeof x.label !== 'string' || x.id == null)) {
      return fail('layout_changed', text.slice(0, 300));
    }

    // Match the normalised name exactly (case, punctuation and legal form ignored). A former name
    // given as "(erstwhile X)" in the site's label also counts, and is marked as such.
    const hits = new Map();
    for (const item of list) {
      const id = String(item.id).split('#').pop();
      for (const part of String(item.label).split('#')) {
        const former = part.match(FORMER);
        const main = part.replace(FORMER, '').trim();
        let matched_on = null;
        if (core(main) === want) matched_on = 'name';
        else if (former && core(former[1]) === want) matched_on = 'former name';
        if (!matched_on) continue;
        if (!/^\d+$/.test(id)) return fail('layout_changed', `non-numeric id for ${main}`);
        if (!hits.has(id)) hits.set(id, { id, label: main, matched_on });
      }
    }

    const source_url = SEARCH_URL;
    if (hits.size === 0) {
      return { status: 'not_found', reason: '', records: [], source_url,
        excerpt: `${list.length} suggestion(s) for "${term}", none with this name` };
    }

    const all = [...hits.values()];
    const results = await Promise.all(all.slice(0, 3).map(detail));
    const records = results.filter(r => r.record).map(r => r.record);
    if (records.length === 0) {
      const f = results[0];
      return fail(f.fail, f.excerpt, f.url || source_url);
    }
    const shown = all.length > 3 ? ` (showing 3 of ${all.length})` : '';
    return {
      status: 'found', reason: '', records,
      source_url: records[0].page_url,
      excerpt: (records.map(r => `${r.name}: ${r.ratings.map(x => `${x.instrument} ${x.rating}`).join('; ') || 'no rated instruments listed'}`).join(' | ') + shown).slice(0, 500),
    };
  } catch (err) {
    return fail(failReason(err), String(err?.message || err));
  }
}
