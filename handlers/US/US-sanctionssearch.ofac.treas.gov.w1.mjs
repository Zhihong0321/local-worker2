export const meta = {
  task: 'US-sanctionssearch.ofac.treas.gov',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'matched_names', 'sdn_id', 'sdn_type', 'programs', 'list', 'address', 'score', 'aliases', 'remarks', 'identifications', 'details_url', 'detail_note'],
  canary: { found: 'BANK MELLI IRAN', not_found: 'QWERTY ZXCVB HOLDINGS LLC' },
};

const BASE = 'https://sanctionssearch.ofac.treas.gov/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Detail pages are optional extras. Skip them when the search has already used this much time, so the whole call stays under 60 s.
const DETAIL_CUTOFF_MS = 30000;
const MAX_DETAILS = 3;

// Trailing legal-form words. Only trailing ones are removed, on both the typed name and the site name.
const LEGAL_FORMS = new Set(['LLC', 'LLP', 'LP', 'LTD', 'LIMITED', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY',
  'PLC', 'GMBH', 'AG', 'SA', 'SAS', 'SRL', 'SARL', 'NV', 'BV', 'KK', 'SDN', 'BHD', 'PTE', 'PVT', 'PRIVATE', 'JSC', 'PJSC',
  'OJSC', 'CJSC', 'OOO', 'SPA', 'AB', 'AS', 'OY']);

const FORM_DEFAULTS = {
  '__EVENTTARGET': '',
  '__EVENTARGUMENT': '',
  'ctl00$MainContent$txtLastName': '',
  'ctl00$MainContent$txtID': '',
  'ctl00$MainContent$txtAddress': '',
  'ctl00$MainContent$txtCity': '',
  'ctl00$MainContent$txtState': '',
  'ctl00$MainContent$ddlType': '',
  'ctl00$MainContent$ddlCountry': '',
  'ctl00$MainContent$ddlList': '',
  'ctl00$MainContent$Slider1': '100',
  'ctl00$MainContent$btnSearch': 'Search',
};

function tokenOf(t) {
  return String(t || '').replace(/&/g, 'AND').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** The name with trailing legal-form words removed, normalised for an exact comparison. */
function keyOf(str) {
  const tokens = String(str || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokenOf(tokens[tokens.length - 1]))) tokens.pop();
  return tokens.map(tokenOf).filter(Boolean).join(' ');
}

/** What is sent to the site: the typed name without trailing legal-form words. */
function searchQuery(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokenOf(tokens[tokens.length - 1]))) tokens.pop();
  return tokens.join(' ');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function inputValue(html, name) {
  const m = html.match(new RegExp(`<input[^>]*\\bname="${name}"[^>]*\\bvalue="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function looksBlocked(html) {
  return /captcha|are you a robot|unusual traffic|access denied|cf-chl|incapsula|request blocked/i.test(html || '');
}

function pageHeaders(cookie) {
  const h = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function cookieHeader(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

/** The results grid: one row per matching name. */
function parseRows(html) {
  const table = html.match(/<table[^>]*id="gvSearchResults"[\s\S]*?<\/table>/i);
  if (!table) return [];
  const rows = [];
  for (const tr of table[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 6) continue;
    const idMatch = cells[0].match(/Details\.aspx\?id=(\d+)/i);
    if (!idMatch) continue;
    rows.push({
      id: idMatch[1],
      name: cleanText(cells[0]),
      address: cleanText(cells[1]),
      type: cleanText(cells[2]),
      programs: cleanText(cells[3]),
      list: cleanText(cells[4]),
      score: cleanText(cells[5]),
    });
  }
  return rows;
}

function parseDetail(html) {
  const t = cleanText(html);
  if (!/\bName:/.test(t) || !/\bProgram:/.test(t)) return null;
  const grab = (re) => {
    const m = t.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    name: grab(/Name:\s*(.+?)\s+Program:/),
    programs: grab(/Program:\s*(.+?)\s+Remarks:/),
    remarks: grab(/Remarks:\s*(.+?)\s+Identifications:/).slice(0, 600),
    identifications: grab(/Identifications:\s*(.+?)\s+(?:Additional Sanctions Information|Aliases:|Addresses:)/).slice(0, 600),
    aliases: grab(/Aliases:\s*(.+?)\s+Addresses:/).replace(/^Type Category Name\s*/, '').slice(0, 800),
  };
}

function couldnt(reason, excerpt, sourceUrl) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const name = String(keyword || '').trim();
  if (!keyOf(name)) return couldnt('other', 'empty company name', BASE);

  try {
    // 1. Open the search page: the form needs its ASP.NET ViewState token and the session cookie.
    const getRes = await fetch(BASE, { headers: pageHeaders(), signal: AbortSignal.timeout(25000) });
    if (getRes.status === 403 || getRes.status === 429) return couldnt('blocked', `HTTP ${getRes.status} on the search page`, BASE);
    if (!getRes.ok) return couldnt('http_error', `HTTP ${getRes.status} on the search page`, BASE);
    const homeHtml = await getRes.text();
    const viewState = inputValue(homeHtml, '__VIEWSTATE');
    const viewStateGen = inputValue(homeHtml, '__VIEWSTATEGENERATOR');
    if (!viewState || !homeHtml.includes('ctl00$MainContent$btnSearch') || !homeHtml.includes('ctl00$MainContent$txtLastName')) {
      return couldnt(looksBlocked(homeHtml) ? 'blocked' : 'layout_changed', cleanText(homeHtml), BASE);
    }
    const cookie = cookieHeader(getRes);

    // 2. Submit the search form the way the browser does (Name field, score 100, all lists and types).
    const query = searchQuery(name);
    const body = new URLSearchParams({
      ...FORM_DEFAULTS,
      '__VIEWSTATE': viewState,
      '__VIEWSTATEGENERATOR': viewStateGen,
      'ctl00$MainContent$txtLastName': query,
    });
    const postRes = await fetch(BASE, {
      method: 'POST',
      headers: { ...pageHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (postRes.status === 403 || postRes.status === 429) return couldnt('blocked', `HTTP ${postRes.status} on the search`, BASE);
    if (!postRes.ok) return couldnt('http_error', `HTTP ${postRes.status} on the search`, BASE);
    const html = await postRes.text();

    const countMatch = html.match(/Lookup Results:\s*(\d+)\s*Found/i);
    if (!countMatch) {
      return couldnt(looksBlocked(html) ? 'blocked' : 'layout_changed', cleanText(html), BASE);
    }
    const expected = Number(countMatch[1]);
    const rows = parseRows(html);
    if (expected > 0 && rows.length === 0) return couldnt('layout_changed', `count says ${expected} but no result rows`, BASE);

    // 3. Keep only rows whose name is the same company (legal form and punctuation ignored).
    const target = keyOf(name);
    const exact = rows.filter((r) => keyOf(r.name) === target);

    if (exact.length === 0) {
      const sample = rows.slice(0, 5).map((r) => r.name).join('; ');
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: BASE,
        excerpt: expected === 0
          ? `Lookup Results: 0 Found for "${query}"`
          : `${rows.length} row(s) for "${query}", none named "${name}". First names: ${sample}`.slice(0, 300),
      };
    }

    // 4. One record per listed entry, with its detail page when there is time for it.
    const ids = [...new Set(exact.map((r) => r.id))].slice(0, MAX_DETAILS);
    const records = [];
    for (const id of ids) {
      const group = exact.filter((r) => r.id === id);
      const first = group[0];
      const detailUrl = `${BASE}Details.aspx?id=${id}`;
      let detail = null;
      let detailNote = '';
      if (Date.now() - started > DETAIL_CUTOFF_MS) {
        detailNote = 'detail page not fetched: time budget used by the search';
      } else {
        try {
          const dRes = await fetch(detailUrl, { headers: pageHeaders(cookie), signal: AbortSignal.timeout(25000) });
          if (!dRes.ok) {
            detailNote = `detail page HTTP ${dRes.status}`;
          } else {
            detail = parseDetail(await dRes.text());
            if (!detail) detailNote = 'detail page layout not as expected';
          }
        } catch (err) {
          detailNote = `detail page error: ${String(err?.name || err).slice(0, 80)}`;
        }
      }
      records.push({
        name: detail?.name || first.name,
        matched_names: [...new Set(group.map((r) => r.name))],
        sdn_id: id,
        sdn_type: first.type,
        programs: detail?.programs || first.programs,
        list: first.list,
        address: first.address,
        score: first.score,
        aliases: detail?.aliases || '',
        remarks: detail?.remarks || '',
        identifications: detail?.identifications || '',
        details_url: detailUrl,
        detail_note: detailNote,
      });
    }

    const top = exact[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].details_url,
      excerpt: `${top.name} | ${top.address} | ${top.type} | ${top.programs} | ${top.list} | score ${top.score}`.slice(0, 300),
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(isTimeout ? 'timeout' : 'other', String(err?.message || err), BASE);
  }
}
