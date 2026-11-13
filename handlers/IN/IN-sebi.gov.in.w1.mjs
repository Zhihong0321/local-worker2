export const meta = {
  task: 'IN-sebi.gov.in',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['title', 'date', 'url', 'excerpt'],
  canary: { found: 'Sunness Capital India Pvt Ltd', not_found: 'क्वर्जपुरम कैपिटल सर्विसेज प्रा. लि.' },
};

const SEARCH_URL = 'https://www.sebi.gov.in/sebiweb/ajax/search/search.jsp';
const PAGE_URL = 'https://www.sebi.gov.in/search.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words ignored when comparing names (English and Hindi forms as SEBI writes them).
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'corp', 'corporation',
  'प्रा', 'प्राइवेट', 'लि', 'लिमिटेड', 'एलएलपी']);

// One search result as the site's AJAX endpoint writes it: <h2><a href=".." class='search-title'>title</a></h2><h5>date</h5><p>text</p>
const ITEM = /<h2>\s*<a href="([^"]+)" class='search-title'[^>]*>([\s\S]*?)<\/a>\s*<\/h2>\s*(?:<h5>([\s\S]*?)<\/h5>)?\s*(?:<p>([\s\S]*?)<\/p>)?/g;

function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Lower-cased words; punctuation (dots, commas, brackets) becomes a space. Hindi matras are kept.
function tokens(str) {
  return (str || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').split(/\s+/).filter(Boolean);
}

function coreTokens(str) {
  const all = tokens(str);
  const core = all.filter((t) => !LEGAL.has(t));
  return core.length ? core : all;
}

// True when the needle words appear next to each other, in order, in the haystack.
function containsSequence(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const name = String(keyword || '').trim();
  const sourceUrl = `${PAGE_URL}?searchval=${encodeURIComponent(name)}`;
  try {
    if (!name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'empty company name' };
    }

    // The same request the site's own search box sends: exact-phrase mode (typeSearch=2), all categories.
    const body = new URLSearchParams({
      next_value: '1', searchval: name, fromDate: '', toDate: '', fval: '',
      typeSearch: '2', next: 's', doDirect: '-1', sortby: '0',
    });
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE_URL,
        'Accept': 'text/html, */*; q=0.01',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: sourceUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|recaptcha|access denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: sourceUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const noRecords = html.includes('No Records Available');
    const items = [...html.matchAll(ITEM)];
    if (!noRecords && items.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: sourceUrl, excerpt: cleanText(html).slice(0, 300) };
    }

    const want = coreTokens(name);
    const records = [];
    for (const m of items) {
      const title = cleanText(m[2]);
      const hay = tokens(title).filter((t) => !LEGAL.has(t));
      if (containsSequence(hay, want)) {
        records.push({
          title,
          date: cleanText(m[3]),
          url: new URL(m[1], PAGE_URL).href,
          excerpt: cleanText(m[4]).slice(0, 300),
        });
      }
    }

    if (records.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: sourceUrl,
        excerpt: noRecords ? 'SEBI search: No Records Available' : `SEBI search returned ${items.length} results, none names this company`,
      };
    }

    return { status: 'found', reason: '', records, source_url: sourceUrl, excerpt: records[0].title.slice(0, 500) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
