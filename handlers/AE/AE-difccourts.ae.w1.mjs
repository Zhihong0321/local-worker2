export const meta = {
  task: 'AE-difccourts.ae',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['case_title', 'claim_no', 'court', 'date', 'matched_in', 'url'],
  canary: { found: 'Mabani Delma General Contracting Co LLC', not_found: 'شركة النخبة للتجارة ذ.م.م' },
};

// The DIFC Courts judgments list has a keyword search (GET ?keywords=). Every word of the keyword must appear in a
// judgment, so a company is "found" only when its full name appears in a judgment, as a token sequence (case,
// punctuation and legal-form spelling ignored). Only the first results page is read.

const BASE = 'https://www.difccourts.ae';
const LIST = `${BASE}/rules-decisions/judgments-orders`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decode(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&rsquo;|&lsquo;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const SYNONYMS = { company: 'co', limited: 'ltd' };

/** Lower-case word tokens; L.L.C. -> llc, F.Z.C.O. -> fzco, Company -> co, Limited -> ltd. */
function tokens(text) {
  const s = ` ${(text || '').toLowerCase()} `
    .replace(/\bl\s*\.?\s*l\s*\.?\s*c\b\.?/g, ' llc ')
    .replace(/\bf\s*\.?\s*z\s*\.?\s*c\s*\.?\s*o\b\.?/g, ' fzco ');
  return s
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => SYNONYMS[t] || t);
}

/** True when the token list `needle` appears as one unbroken run inside `hay`. */
function containsSeq(hay, needle) {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, text: res.ok ? await res.text() : '' };
}

function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

/** One entry per result on the results page: url, title, label (date + court), and the summary text. */
function parseHits(html) {
  return html
    .split('class="each_result content_set"')
    .slice(1)
    .map((part) => {
      const href = part.match(/<h4>\s*<a href="([^"]+)"/i)?.[1];
      return {
        url: href ? new URL(decode(href), BASE).href : '',
        title: clean(part.match(/<h4>([\s\S]*?)<\/h4>/i)?.[1]),
        label: clean(part.match(/<p class="label_small">([\s\S]*?)<\/p>/i)?.[1]),
        desc: clean(part.match(/<p class="content_desc">([\s\S]*?)<\/p>/i)?.[1]),
      };
    })
    .filter((h) => h.url);
}

function toRecord(h, matchedIn) {
  const m = h.label.match(/^([A-Z][a-z]+ \d{1,2}, \d{4})\s+(.*)$/);
  return {
    case_title: h.title,
    claim_no: h.desc.match(/Claim No:?\s*([A-Z]{2,5}[ -]?\d[\d/-]*)/)?.[1] || '',
    court: m ? m[2] : h.label,
    date: m ? m[1] : '',
    matched_in: matchedIn,
    url: h.url,
  };
}

async function run(keyword) {
  const name = String(keyword ?? '').trim();
  const searchUrl = `${LIST}?keywords=${encodeURIComponent(name)}`;
  const done = (status, reason, excerpt, records = []) => ({
    status, reason, records, source_url: searchUrl, excerpt: String(excerpt || '').slice(0, 500),
  });

  try {
    const want = tokens(name);
    if (want.length === 0) return done('couldnt_check', 'other', 'empty company name');

    const page = await get(searchUrl);
    if (page.status === 403 || page.status === 429) return done('couldnt_check', 'blocked', `HTTP ${page.status}`);
    if (page.status !== 200) return done('couldnt_check', 'http_error', `HTTP ${page.status}`);

    const html = page.text;
    if (!html.includes('id="basic_search"')) {
      const blocked = /captcha challenge|cf-chl|Just a moment|Attention Required|Access denied/i.test(html);
      return done('couldnt_check', blocked ? 'blocked' : 'layout_changed', clean(html).slice(0, 300));
    }

    const hits = parseHits(html);
    const moreRange = /rel="next"/.test(html);

    // Hits whose visible title/summary already contain the full name are matches. The summary is cut short, so
    // the other hits are opened and checked against the whole judgment text.
    const direct = [];
    const deep = [];
    for (const h of hits) {
      if (containsSeq(tokens(`${h.title} ${h.desc}`), want)) direct.push(toRecord(h, 'case title or summary'));
      else deep.push(h);
    }

    const checks = await Promise.all(deep.map(async (h) => {
      try {
        const r = await get(h.url);
        if (r.status !== 200) {
          const reason = r.status === 403 || r.status === 429 ? 'blocked' : 'http_error';
          return { h, reason, excerpt: `HTTP ${r.status} ${h.url}` };
        }
        return { h, hit: containsSeq(tokens(clean(r.text)), want) };
      } catch (e) {
        return { h, reason: errReason(e), excerpt: String(e?.message || e) };
      }
    }));

    const records = [...direct, ...checks.filter((c) => c.hit).map((c) => toRecord(c.h, 'full judgment text'))];
    if (records.length > 0) {
      return done('found', '', `${records.length} judgment(s) name "${name}": ${records[0].case_title}`, records);
    }

    const failed = checks.find((c) => c.reason);
    if (failed) return done('couldnt_check', failed.reason, `could not read ${failed.h.url}: ${failed.excerpt}`);

    if (moreRange) {
      return done('couldnt_check', 'other', 'first results page has no match, but the results run to more pages, which this handler does not read');
    }

    return done('not_found', '', hits.length
      ? `${hits.length} judgment(s) matched the words, none names "${name}"`
      : 'the search returned 0 results');
  } catch (e) {
    return done('couldnt_check', errReason(e), String(e?.message || e));
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The pause before returning is a workaround: on Windows, Node 24 asserts (exit code 127) when the runner calls
 * process.exit while a keep-alive socket from fetch is still closing. Waiting lets the sockets settle first.
 */
export default async function lookup(keyword) {
  const result = await run(keyword);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return result;
}
