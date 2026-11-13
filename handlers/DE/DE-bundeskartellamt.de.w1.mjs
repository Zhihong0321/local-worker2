export const meta = { task: 'DE-bundeskartellamt.de', want: 'w1', tier: 1, method: 'url_template', pdf: false, input: 'company name',
  fields: ['name', 'case_number', 'decision_date', 'title', 'area', 'decision_type', 'kind', 'url'],
  canary: { found: 'T-Mobile Deutschland GmbH', not_found: 'Zwirbelmueller Quantenwerk GmbH' } };

// Public decision database (Entscheidungsdatenbank) of the Bundeskartellamt: a plain GET search by text.
// The Wettbewerbsregister (exclusion records) is NOT public and is not searched here.
const SEARCH = 'https://www.bundeskartellamt.de/SiteGlobals/Forms/Suche/Entscheidungsdatenbanksuche_Formular.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['gmbh', 'ag', 'kg', 'ohg', 'gbr', 'se', 'ug', 'co', 'mbh', 'kgaa', 'ev', 'eg', 'ltd', 'inc',
  'llc', 'plc', 'sarl', 'sa', 'bv', 'ab', 'spa', 'srl']);

function tokens(str) {
  return (str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

// True when the company name (legal form removed) appears as a whole run of words in the text, followed by
// a legal form, "und", or the end of the text. "Deutsche Telekom" does not match "Deutsche Telekom Technik GmbH".
function namesCompany(textTokens, coreTokens) {
  const n = coreTokens.length;
  for (let i = 0; i + n <= textTokens.length; i++) {
    let same = true;
    for (let j = 0; j < n; j++) {
      if (textTokens[i + j] !== coreTokens[j]) { same = false; break; }
    }
    if (!same) continue;
    const next = textTokens[i + n];
    if (next === undefined || LEGAL_FORMS.has(next) || next === 'und') return true;
  }
  return false;
}

function parseRows(html) {
  const out = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    if (!row.includes('c-searchresult-table__title')) continue;
    const cells = row.match(/<td[\s\S]*?<\/td>/g) || [];
    if (cells.length < 4) continue;
    const cell0 = cells[0];
    const aTag = (cell0.match(/<a[^>]*c-searchresult-table__title[^>]*>/) || [''])[0];
    const aBody = (cell0.match(/<a[^>]*c-searchresult-table__title[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    const href = (aTag.match(/href="([^"]+)"/) || [])[1] || '';
    const excerpt = cleanText((cell0.match(/c-searchresult-table__excerpt"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    const kind = [...cell0.matchAll(/c-topline__item"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => cleanText(m[1])).join(' ');
    out.push({
      case_number: cleanText(aBody),
      url: href ? new URL(href, SEARCH).href : '',
      kind,
      excerpt,
      decision_date: cleanText(cells[1]),
      area: cleanText(cells[2]),
      decision_type: cleanText(cells[3]),
    });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let searchUrl = SEARCH;
  try {
    const query = String(keyword || '').replace(/^[*?\s]+/, '').trim().slice(0, 100);
    const core = tokens(query).filter((t) => !LEGAL_FORMS.has(t));
    if (!core.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH, excerpt: 'no company name words in input' };
    }
    searchUrl = `${SEARCH}?${new URLSearchParams({ templateQueryString: query }).toString()}`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const countMatch = html.match(/(\d+)\s+Eintr/);
    const total = countMatch ? parseInt(countMatch[1], 10) : 0;
    const rows = parseRows(html);

    if (!rows.length) {
      if (total > 0) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: `${total} entries reported, no rows parsed` };
      }
      if (html.includes('Keine Treffer') && html.includes('Entscheidungsdatenbank')) {
        return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: 'Keine Treffer' };
      }
      if (/captcha|Zugriff verweigert|access denied/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot or access check page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: html.slice(0, 300) };
    }

    const matched = rows.filter((r) => namesCompany(tokens(r.excerpt), core));
    if (!matched.length) {
      if (total > rows.length) {
        // The site lists more decisions than this page shows; absence cannot be proven from page 1.
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
          excerpt: `${total} decisions match the text, only the first ${rows.length} are readable; none names the company on that page` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `${rows.length} decisions match the text, none names the company` };
    }

    return {
      status: 'found',
      reason: '',
      records: matched.map((r) => ({
        name: query,
        case_number: r.case_number,
        decision_date: r.decision_date,
        title: r.excerpt,
        area: r.area,
        decision_type: r.decision_type,
        kind: r.kind,
        url: r.url,
      })),
      source_url: searchUrl,
      excerpt: matched[0].excerpt.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
