export const meta = {
  task: 'VN-ccifv.org',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'sector', 'city', 'website'],
  canary: { found: 'CÔNG TY TNHH SANOFI-AVENTIS VIỆT NAM', not_found: 'CÔNG TY TNHH DEZENO VIỆT NAM' },
};

// CCIFV online directory ("Annuaire en ligne"): a public list of member companies with a keyword filter.
// The filter is a plain GET on the directory page; results are paged with a rel="next" link.
const DIRECTORY = 'https://www.ccifv.org/adhesion/annuaire-en-ligne.html';
const SEARCH_PARAM = 'tx_obladyannuaire_annuairelist%5Bfilters%5D%5Bsearch%5D';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 5;
// A further page is fetched only if less than 30 s have passed, so the last fetch ends before 55 s (limit 60 s).
const NO_NEW_PAGE_AFTER_MS = 30000;

// Legal-form words (Vietnamese and English). Phrases come first so that e.g. "LIMITED LIABILITY COMPANY" goes as one.
const LEGAL_FORMS = [
  'CONG TY TNHH MOT THANH VIEN', 'CONG TY CO PHAN', 'CONG TY TNHH', 'CONG TY', 'CO PHAN', 'MOT THANH VIEN',
  'TNHH', 'DNTN', 'HKD',
  'LIMITED LIABILITY COMPANY', 'COMPANY LIMITED', 'PRIVATE LIMITED', 'SDN BHD', 'PTE LTD', 'CO LTD',
  'LIMITED', 'LTD', 'LLC', 'LLP', 'JSC', 'PLC', 'INC', 'CORPORATION', 'CORP', 'COMPANY', 'GMBH', 'SARL', 'SASU',
  'SAS', 'BHD', 'PTE', 'MTV', 'CO',
];

/** Upper-case ASCII words: diacritics (incl. Vietnamese đ) and punctuation removed. */
function fold(s) {
  return String(s || '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** The name's words without legal form (used as the search term and for comparison). */
function coreWords(name) {
  const full = fold(name);
  let t = ` ${full} `;
  let before;
  do {
    before = t;
    for (const form of LEGAL_FORMS) {
      const needle = ` ${form} `;
      while (t.includes(needle)) t = t.replace(needle, ' ');
    }
  } while (t !== before);
  return t.trim() || full;
}

/** Comparison key: normalised core words with no spaces. Two names match only when the keys are equal. */
function matchKey(name) {
  return coreWords(name).replace(/ /g, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Each directory entry: <article class="thumbnail ..."> with h2.title (name), then plain <p> (sector, city), then a website link. */
function parseEntries(html) {
  const start = html.indexOf('tx-oblady-annuaire');
  const area = start >= 0 ? html.slice(start) : html;
  const entries = [];
  for (const block of area.split('<article class="thumbnail').slice(1)) {
    const body = block.split('</article>')[0];
    const h2 = body.match(/<h2 class="title">([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const paras = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    const plain = paras.filter((p) => !/<a\b/i.test(p)).map(clean).filter(Boolean);
    const site = body.match(/<a [^>]*href="(https?:[^"]+)"/i);
    entries.push({
      name: clean(h2[1]),
      sector: plain[0] || '',
      city: plain[1] || '',
      website: site ? decode(site[1]) : '',
    });
  }
  return entries;
}

function nextPage(html, current) {
  const m = html.match(/<a[^>]*rel="next"[^>]*href="([^"]+)"/i) || html.match(/<a[^>]*href="([^"]+)"[^>]*rel="next"/i);
  return m ? new URL(decode(m[1]), current).href : null;
}

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let searchUrl = '';
  try {
    const term = coreWords(keyword);
    const key = matchKey(keyword);
    searchUrl = `${DIRECTORY}?${SEARCH_PARAM}=${encodeURIComponent(term)}`;
    if (!key) return answer('couldnt_check', 'other', [], searchUrl, 'empty company name');

    const matches = [];
    let entriesSeen = 0;
    let url = searchUrl;
    for (let page = 1; url; page++) {
      if (page > MAX_PAGES) {
        return answer('couldnt_check', 'other', [], searchUrl, `more than ${MAX_PAGES} result pages; not all checked`);
      }
      if (page > 1 && Date.now() - started > NO_NEW_PAGE_AFTER_MS) {
        return answer('couldnt_check', 'timeout', [], searchUrl, `stopped after ${page - 1} result pages to stay under 60 s`);
      }
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr,en;q=0.8',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 403 || res.status === 429) {
        return answer('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`);
      }
      if (!res.ok) {
        return answer('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`);
      }
      const html = await res.text();
      const entries = parseEntries(html);

      if (entries.length === 0) {
        if (page === 1 && /[>]\s*Aucun contact trouv/i.test(html)) {
          return answer('not_found', '', [], searchUrl, 'the directory search shows: Aucun contact trouvé pour les critères sélectionnés');
        }
        if (page === 1 && !/tx-oblady-annuaire/.test(html)) {
          if (/captcha|cf-chl|challenge-platform|Just a moment/i.test(html)) {
            return answer('couldnt_check', 'blocked', [], url, 'bot or captcha check page');
          }
          return answer('couldnt_check', 'layout_changed', [], url, clean(html).slice(0, 300));
        }
        break;
      }

      entriesSeen += entries.length;
      for (const e of entries) {
        if (matchKey(e.name) === key) matches.push(e);
      }
      url = nextPage(html, url);
    }

    if (matches.length) {
      return answer(
        'found',
        '',
        matches.map((m) => ({ name: m.name, sector: m.sector, city: m.city, website: m.website })),
        searchUrl,
        `${matches.length} match(es): ${matches[0].name} | ${matches[0].sector} | ${matches[0].city}`.slice(0, 500),
      );
    }
    return answer('not_found', '', [], searchUrl, `the directory search returned ${entriesSeen} entries, none with this name`);
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'timeout' : 'other';
    return answer('couldnt_check', reason, [], searchUrl, String(err?.message || err).slice(0, 300));
  }
}
