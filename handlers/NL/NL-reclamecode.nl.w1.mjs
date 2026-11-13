export const meta = {
  task: 'NL-reclamecode.nl',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['dossier', 'date', 'status', 'product', 'motivation', 'decision', 'ruling_url', 'summary'],
  canary: { found: 'KLM', not_found: 'Zwanenburg Vastgoed Onderhoud B.V.' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.reclamecode.nl';
const SEARCH = BASE + '/uitspraken/uitspraken-zoeken/';
const MAX_PAGES = 3;      // result pages read (10 rulings per page)
const MAX_CHECKS = 6;     // ruling detail pages fetched to confirm a name
const MAX_MS = 40000;     // no new fetch is started after this, so the call ends well under 60 s
const LEGAL_RE = /(?:[\s,]+|^)(?:b\.?\s*v\.?|n\.?\s*v\.?|bvba|vof|cv|ltd\.?|limited|inc\.?|llc|gmbh|plc|sas|sarl|corp\.?|sa|ag)\s*\.?$/i;

function safeChr(n) {
  try { return String.fromCodePoint(n); } catch { return ' '; }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChr(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripTags(html) {
  return decodeEntities(
    (html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// lower case, accents removed, punctuation to spaces: "Stëlz B.V." -> "stelz b v"
function plain(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// the name as a whole-word phrase inside a text
function hasName(text, key) {
  return (' ' + plain(text) + ' ').includes(' ' + key + ' ');
}

// the keyword without its legal form, keeping the original spelling for the site search
function searchTerm(keyword) {
  let s = (keyword || '').trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) {
    const t = s.replace(LEGAL_RE, '').trim();
    if (t === s || t === '') break;
    s = t;
  }
  return s;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.7',
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = res.ok ? await res.text() : '';
  return { ok: res.ok, status: res.status, text };
}

function looksBlocked(html) {
  return /captcha|cf-chl|just a moment|access denied/i.test(html.slice(0, 4000));
}

function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

function parseCard(cardHtml) {
  const text = stripTags(cardHtml);
  const field = (re) => { const m = text.match(re); return m ? m[1].trim() : ''; };
  const h3 = cardHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  const link = cardHtml.match(/href="(\/uitspraak\/\?uitspraakId=\d+)"/i);
  return {
    text,
    dossier: h3 ? stripTags(h3[1]) : '',
    date: field(/Datum\.\s*(\d{1,2}-\d{1,2}-\d{4})/),
    status: field(/Status:\s*(.+?)\s+Dossienr\./),
    product: field(/Product\/dienst:\s*(.+?)\s+Datum\./),
    motivation: field(/Motivatie:\s*(.+?)\s+Uitspraak\./),
    decision: field(/Uitspraak\.\s*(.+?)\s+Medium:/),
    ruling_url: link ? BASE + link[1] : '',
  };
}

function toRecord(card) {
  return {
    dossier: card.dossier,
    date: card.date,
    status: card.status,
    product: card.product,
    motivation: card.motivation,
    decision: card.decision,
    ruling_url: card.ruling_url,
    summary: card.text.slice(0, 300),
  };
}

async function run(keyword) {
  const started = Date.now();
  const term = searchTerm(keyword);
  const key = plain(term);
  const pageUrl = (page) => `${SEARCH}?Trefwoord=${encodeURIComponent(term)}${page > 1 ? `&pagina=${page}` : ''}`;
  const firstUrl = pageUrl(1);

  try {
    if (key.replace(/\s/g, '').length < 2) return couldnt('other', firstUrl, 'name too short to search');

    const records = [];
    let hitsTotal = null;     // rulings the site says match the search
    let cardsSeen = 0;
    let skipped = 0;          // rulings not checked because of the limits
    let checks = 0;
    let unresolved = null;    // reason from a ruling page that could not be read

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && (hitsTotal === null || cardsSeen >= hitsTotal)) break;
      if (Date.now() - started > MAX_MS) break;

      const url = pageUrl(page);
      let res;
      try {
        res = await get(url);
      } catch (e) {
        return couldnt(errReason(e), url, String(e && e.message || e));
      }
      if (res.status === 403 || res.status === 429) return couldnt('blocked', url, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);
      const html = res.text;
      if (looksBlocked(html)) return couldnt('blocked', url, 'bot or captcha check page');

      const noResults = /Geen resultaten gevonden/i.test(html);
      const cards = html.split('<div class="rl_layout242_item">').slice(1);
      if (page === 1) {
        const count = stripTags(html).match(/(\d[\d.]*)\s*Resultaten/);
        if (count) hitsTotal = parseInt(count[1].replace(/\./g, ''), 10);
        else if (noResults) hitsTotal = 0;
        if (hitsTotal === null && cards.length === 0) {
          return couldnt('layout_changed', url, html.slice(0, 300));
        }
        if (hitsTotal === 0 || (noResults && cards.length === 0)) {
          return { status: 'not_found', reason: '', records: [], source_url: url,
            excerpt: `The site search has no rulings for "${term}"` };
        }
      }

      for (const cardHtml of cards) {
        cardsSeen++;
        const card = parseCard(cardHtml);
        if (hasName(card.text, key)) {
          records.push(toRecord(card));
          continue;
        }
        // the name is not in the result summary: read the full ruling before deciding
        if (!card.ruling_url) { skipped++; continue; }
        if (checks >= MAX_CHECKS || Date.now() - started > MAX_MS) { skipped++; continue; }
        checks++;
        try {
          const detail = await get(card.ruling_url);
          if (detail.status === 403 || detail.status === 429) { unresolved = unresolved || 'blocked'; continue; }
          if (!detail.ok) { unresolved = unresolved || 'http_error'; continue; }
          if (hasName(stripTags(detail.text), key)) records.push(toRecord(card));
        } catch (e) {
          unresolved = unresolved || errReason(e);
        }
      }
      if (records.length >= 3) break;
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: firstUrl,
        excerpt: `${records.length} ruling(s) on the site name "${term}"` };
    }
    if (unresolved) {
      return couldnt(unresolved, firstUrl, `ruling pages could not be read while checking "${term}"`);
    }
    if (hitsTotal !== null && cardsSeen >= hitsTotal && skipped === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `${hitsTotal} ruling(s) matched the search, none names "${term}" in its text` };
    }
    return couldnt('other', firstUrl,
      `the search returned ${hitsTotal} ruling(s); "${term}" could not be confirmed within the check limit`);
  } catch (e) {
    return couldnt(errReason(e), firstUrl, String(e && e.message || e));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await run(keyword);
  } catch (e) {
    answer = couldnt('other', SEARCH, String(e && e.message || e));
  }
  // Node on Windows can abort at process exit while the last keep-alive socket is still closing
  // (libuv assertion, exit 127, after the answer is printed). A short settle time avoids it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}
