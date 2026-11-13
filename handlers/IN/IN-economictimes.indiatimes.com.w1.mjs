export const meta = {
  task: 'IN-economictimes.indiatimes.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'short_name', 'company_id', 'nse_symbol', 'bse_code', 'sector', 'industry', 'registered_office', 'city', 'state', 'pincode', 'incorporated_year', 'market_cap_type', 'website'],
  canary: { found: 'Reliance Industries Ltd.', not_found: 'डेज़ेनो प्राइवेट लिमिटेड' },
};

// The site's search box is GET /searchresult.cms?query=...; when the search matches a listed company the server
// redirects to that company's stock profile (/<slug>/stocks/companyid-<id>.cms). Otherwise it lands on a news
// topic page (/topic/... or a section page), which has no company record.

const BASE = 'https://economictimes.indiatimes.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};
const LEGAL_FORMS = new Set(['ltd', 'limited', 'pvt', 'private', 'pte', 'sdn', 'bhd', 'llp', 'llc', 'inc', 'co', 'company', 'corp', 'corporation', 'plc', 'public', 'the']);
const DEADLINE_MS = 50000; // the whole call must finish in under 60 s

function wordKey(w) {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Comparison form of a name: lower case, '&' = 'and', punctuation and legal-form words dropped. */
function normalizeName(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

/** The keyword with legal-form words removed; original spelling kept, used only as search text. */
function strippedKeyword(keyword) {
  return keyword.split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(wordKey(w))).join(' ');
}

function decodeJsonString(s) {
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s;
  }
}

function cleanText(s) {
  return decodeJsonString(String(s || '')).replace(/\s+/g, ' ').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || '', excerpt: String(excerpt || '').slice(0, 500) };
}

/** Read the company profile out of an ET stock page. Returns null when the expected markers are missing. */
function parseStockPage(html, companyId) {
  const u = html.replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  const m = u.match(new RegExp('"companyId":"' + companyId + '","companyName":"([^"]*)","companyShortName":"([^"]*)"'));
  if (!m) return null;
  const at = m.index;
  const near = u.slice(Math.max(0, at - 400), at + 3000);
  const pick = (re, src) => {
    const x = (src === undefined ? near : src).match(re);
    return x ? cleanText(x[1]) : '';
  };
  const roIdx = u.indexOf('"locationtype":"Registered Office"');
  const ro = roIdx >= 0 ? u.slice(roIdx, roIdx + 900) : '';
  const address = ['addressline1', 'addressline2', 'addressline3']
    .map((k) => pick(new RegExp('"' + k + '":"([^"]*)"'), ro))
    .filter(Boolean)
    .join(' ');
  const inc = u.match(/incorporated in the year (\d{4})/i);
  return {
    id: companyId,
    name: cleanText(m[1]),
    short: cleanText(m[2]),
    nse: pick(/"nseScripCode":"([^"]*)"/),
    bse: pick(/"bseScripCode":"([^"]*)"/),
    sector: pick(/"sectorName":"([^"]*)"/),
    industry: pick(/"industryName":"([^"]*)"/),
    capType: pick(/"marketCapType":"([^"]*)"/, u.slice(at, at + 6000)),
    address,
    city: pick(/"city":"([^"]*)"/, ro),
    state: pick(/"state":"([^"]*)"/, ro),
    pincode: pick(/"pincode":"([^"]*)"/, ro),
    website: pick(/"weburl":"([^"]*)"/, ro),
    incorporated: inc ? inc[1] : '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const deadline = Date.now() + DEADLINE_MS;

  // The site's search treats "Ltd" / "Pvt Ltd" differently, so a second and third search text are tried when
  // the first one does not open a company profile. The name check below always uses the keyword as typed.
  const variants = [keyword];
  const stripped = strippedKeyword(keyword);
  if (stripped) {
    for (const v of [stripped + ' Ltd', stripped]) {
      if (!variants.some((x) => x.toLowerCase() === v.toLowerCase())) variants.push(v);
    }
  }

  const want = normalizeName(keyword);
  let lastUrl = '';
  let mismatch = null; // first stock profile the site opened whose name is not the keyword

  try {
    for (const q of variants) {
      const left = deadline - Date.now();
      if (left < 2000) return fail('timeout', lastUrl, 'ran out of time before every search text was tried');

      const searchUrl = `${BASE}/searchresult.cms?query=${encodeURIComponent(q)}`;
      lastUrl = searchUrl;
      const res = await fetch(searchUrl, {
        redirect: 'follow',
        headers: HEADERS,
        signal: AbortSignal.timeout(Math.min(25000, left)),
      });
      const finalUrl = res.url || searchUrl;
      lastUrl = finalUrl;

      if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
      if (!res.ok) return fail('http_error', finalUrl, `HTTP ${res.status}`);

      const html = await res.text();
      const stock = finalUrl.match(/\/stocks\/companyid-(\d+)\.cms/);

      if (!stock) {
        if (!/The Economic Times/i.test(html)) {
          if (/captcha|access denied|unusual traffic|are you a robot|verify you are human/i.test(html)) {
            return fail('blocked', finalUrl, 'bot check page');
          }
          return fail('layout_changed', finalUrl, html.slice(0, 300));
        }
        continue; // a news topic page: this search text has no company profile
      }

      const co = parseStockPage(html, stock[1]);
      if (!co) return fail('layout_changed', finalUrl, 'stock profile markers not found');
      if (!want) return fail('other', finalUrl, 'the name has no Latin letters to compare with the site');

      if (want === normalizeName(co.name) || want === normalizeName(co.short)) {
        return {
          status: 'found',
          reason: '',
          records: [{
            name: co.name,
            short_name: co.short,
            company_id: co.id,
            nse_symbol: co.nse,
            bse_code: co.bse,
            sector: co.sector,
            industry: co.industry,
            registered_office: co.address,
            city: co.city,
            state: co.state,
            pincode: co.pincode,
            incorporated_year: co.incorporated,
            market_cap_type: co.capType,
            website: co.website,
          }],
          source_url: finalUrl,
          excerpt: `${co.name} (${co.short}) | NSE ${co.nse} | BSE ${co.bse} | ${co.sector} / ${co.industry}`.slice(0, 500),
        };
      }
      if (!mismatch) mismatch = { url: finalUrl, name: co.name, short: co.short };
    }
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', lastUrl, String(err?.message || err));
  }

  if (mismatch) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: mismatch.url,
      excerpt: `search for "${keyword}" opened the profile of "${mismatch.name}" (${mismatch.short}); the names do not match`,
    };
  }
  // The site turns non-Latin text into "???" and returns its home topic page, so say so in the excerpt.
  const scriptNote = /\/topic\/home\b/.test(lastUrl) ? ' (the site search does not handle this script; it returned its home topic page)' : '';
  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl,
    excerpt: `search for "${keyword}" opened a news topic page, not a company profile: no company record on the site${scriptNote}`,
  };
}
