export const meta = {
  task: 'AE-alittihad.ae',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'ticker', 'listing_url', 'list_label'],
  canary: { found: 'أدنوك للتوزيع', not_found: 'شركة الواحة الصحراوية للتجارة العامة' },
};

// The site's own stock search (the box on /stock) runs on this list, embedded in the page as searchData.push({...}).
// Each entry is one securities listing: "TICKER - Arabic name" plus a /stock/<id>/<name> detail link.
const SOURCE = 'https://www.aletihad.ae/stock';
const SITE = 'https://www.aletihad.ae';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words and letters, removed before comparing names (after dots and punctuation are stripped).
const LEGAL_TOKENS = new Set([
  'شركة', 'شمع', 'شمح', 'شمخ', 'ذمم', 'شذمم', 'مساهمة', 'مساهمه', 'عامة', 'عامه', 'مسؤولية', 'محدودة', 'محدوده',
  'ش', 'م', 'ع', 'ذ', 'ح', 'خ',
  'llc', 'pjsc', 'psc', 'fze', 'fzco', 'fzc', 'ltd', 'limited', 'inc', 'plc', 'co', 'company', 'corp',
]);

function normalizeName(str) {
  const s = String(str || '')
    .normalize('NFKC')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')   // tatweel and harakat
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // alef forms -> alef
    .replace(/\u0629/g, '\u0647')                  // ta marbuta -> ha
    .replace(/\u0649/g, '\u064A')                  // alef maksura -> ya
    .replace(/\u0624/g, '\u0648')                  // hamza on waw -> waw
    .replace(/\u0626/g, '\u064A')                  // hamza on ya -> ya
    .toLowerCase()
    .replace(/[.,\-_()\[\]"'«»\/\\&:;!?،؛؟*+]/g, ' ');
  return s.split(/\s+/).filter((t) => t && !LEGAL_TOKENS.has(t)).join(' ');
}

function unescapeJs(s) {
  return s.replace(/\\(['"\\])/g, '$1');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  try {
    if (!name) return fail('other', SOURCE, 'empty company name');

    // The page is sometimes slow (seen 28 s to first byte). Two attempts of 25 s each fit the 60 s limit.
    let html = '';
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && html === ''; attempt++) {
      try {
        const res = await fetch(SOURCE, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar,en;q=0.8',
          },
          signal: AbortSignal.timeout(25000),
        });
        if (res.status === 403 || res.status === 429) return fail('blocked', SOURCE, `HTTP ${res.status}`);
        if (!res.ok) return fail('http_error', SOURCE, `HTTP ${res.status}`);
        html = await res.text();
      } catch (e) {
        lastErr = e;
      }
    }
    if (html === '') {
      const timedOut = lastErr && (lastErr.name === 'TimeoutError' || lastErr.name === 'AbortError');
      return fail(timedOut ? 'timeout' : 'other', SOURCE, lastErr?.message || 'empty page');
    }

    const pushes = (html.match(/searchData\.push\(/g) || []).length;
    const blockRe = /var url = '((?:[^'\\]|\\.)*)';\s*var exists[\s\S]*?label: '((?:[^'\\]|\\.)*)'/g;
    const entries = [];
    let m;
    while ((m = blockRe.exec(html)) !== null) {
      const label = unescapeJs(m[2]);
      const cut = label.indexOf(' - ');
      if (cut < 0) continue;
      entries.push({
        ticker: label.slice(0, cut).trim(),
        name: label.slice(cut + 3).trim(),
        label,
        listing_url: new URL(unescapeJs(m[1]), SITE).href,
      });
    }
    if (!pushes || entries.length === 0 || entries.length !== pushes) {
      return fail('layout_changed', SOURCE, `found ${pushes} list entries, parsed ${entries.length}`);
    }

    const kwNorm = normalizeName(name);
    const kwTicker = name.toUpperCase();
    const hits = entries.filter((e) =>
      e.ticker.toUpperCase() === kwTicker || (kwNorm && normalizeName(e.name) === kwNorm));

    if (hits.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: hits.map((h) => ({
          name: h.name,
          ticker: h.ticker,
          listing_url: h.listing_url,
          list_label: h.label,
        })),
        source_url: SOURCE,
        excerpt: hits.map((h) => h.label).join(' | ').slice(0, 300),
      };
    }

    // The list is written in Arabic (with tickers). A Latin-only name cannot be matched against it,
    // so that is not a proof of absence.
    if (!/[\u0600-\u06FF]/.test(name)) {
      return fail('other', SOURCE, 'the list uses Arabic names and tickers; a Latin-only name cannot be matched here');
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: SOURCE,
      excerpt: `no match by name or ticker in the site's list of ${entries.length} listed securities`,
    };
  } catch (err) {
    return fail('other', SOURCE, err?.message || err);
  }
}
