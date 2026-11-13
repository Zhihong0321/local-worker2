export const meta = { task: 'AU-buyingfor.vic.gov.au', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'contract', 'contract_url', 'abn', 'excerpt'],
  canary: { found: 'Lenovo (Australia & New Zealand) Pty Ltd', not_found: 'Zorbex Unlisted Trading Pty Ltd' } };

const BASE = 'https://www.buyingfor.vic.gov.au';
const LIST_URL = `${BASE}/browse-government-contracts`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = ['pty', 'ltd', 'limited', 'pte', 'inc'];
const WORKERS = 8;
// No new page is started after 30 s, so the last one (at most 25 s) ends before the 60 s limit.
const NO_NEW_FETCH_AFTER_MS = 30000;

function decode(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;|’|‘/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, ' ');
}

// Words of a name, lower case, '&' read as 'and', punctuation dropped (so "Pty. Ltd." and "Pty Ltd" are the same).
function nameTokens(text) {
  return (text.match(/[\p{L}\p{N}]+|&/gu) || []).map((t) => (t === '&' ? 'and' : t.toLowerCase()));
}

// Splits the typed name into the company words and its trailing legal form ("pty ltd").
function parseKeyword(keyword) {
  const all = nameTokens(keyword);
  const legal = [];
  while (all.length > 1 && LEGAL.includes(all[all.length - 1])) legal.unshift(all.pop());
  return { base: all, legal };
}

// Every place in the page where the company words appear as whole words. When the typed name has a legal form,
// the page must show one right after the company words too, so "Telstra Pty Ltd" does not match
// "Telstra Corporation Limited". Returns the exact text as the page writes it.
function findNames(text, kw) {
  const toks = [];
  const re = /[\p{L}\p{N}]+|&/gu;
  let m;
  while ((m = re.exec(text))) {
    toks.push({ t: m[0] === '&' ? 'and' : m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
  }
  const hits = [];
  const b = kw.base;
  for (let i = 0; i + b.length <= toks.length; i++) {
    let same = true;
    for (let k = 0; k < b.length; k++) {
      if (toks[i + k].t !== b[k]) { same = false; break; }
    }
    if (!same) continue;
    let j = i + b.length;
    while (j < toks.length && LEGAL.includes(toks[j].t)) j++;
    const legalCount = j - (i + b.length);
    if (kw.legal.length && legalCount === 0) continue;
    hits.push({ start: toks[i].s, end: toks[j - 1].e });
  }
  return hits;
}

async function get(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });
  return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
}

function failReason(status) {
  return status === 403 || status === 429 ? 'blocked' : 'http_error';
}

function errReason(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'other';
}

const answer = (status, reason, source_url, excerpt, records = []) => ({ status, reason, records, source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = parseKeyword(String(keyword || ''));
    if (!kw.base.length || kw.base.every((t) => LEGAL.includes(t))) {
      return answer('couldnt_check', 'other', LIST_URL, 'the name has no company words to search for');
    }

    // Step 1: the list of contract and panel pages. Supplier names are printed on those pages.
    const list = await get(LIST_URL);
    if (!list.ok) return answer('couldnt_check', failReason(list.status), LIST_URL, `HTTP ${list.status}`);
    if (/captcha|access denied|are you a robot/i.test(list.text.slice(0, 4000))) {
      return answer('couldnt_check', 'blocked', LIST_URL, 'bot check page');
    }
    if (!/Browse goods and services contracts/i.test(list.text)) {
      return answer('couldnt_check', 'layout_changed', LIST_URL, decode(list.text).slice(0, 300));
    }
    const slugs = [...new Set([...list.text.matchAll(/href="\/([a-z0-9-]+)"/g)].map((m) => m[1]))]
      .filter((s) => /contract|panel|security|servicenow|register/.test(s) && !/^(browse|about|state)-/.test(s));
    if (!slugs.length) return answer('couldnt_check', 'layout_changed', LIST_URL, 'no contract links found on the list page');

    // Step 2: read each contract page (a few at a time).
    const pages = new Array(slugs.length);
    let next = 0;
    const worker = async () => {
      while (next < slugs.length) {
        const idx = next++;
        const url = `${BASE}/${slugs[idx]}`;
        if (Date.now() - started > NO_NEW_FETCH_AFTER_MS) {
          pages[idx] = { url, reason: 'timeout', excerpt: 'not read: the 30 s limit was reached' };
          continue;
        }
        try {
          const r = await get(url);
          pages[idx] = r.ok ? { url, html: r.text } : { url, reason: failReason(r.status), excerpt: `HTTP ${r.status}` };
        } catch (e) {
          pages[idx] = { url, reason: errReason(e), excerpt: String(e?.message || e).slice(0, 200) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, slugs.length) }, worker));

    // Step 3: match the company on each page that could be read.
    const kwName = keyword;
    const records = [];
    const failed = [];
    for (const p of pages) {
      if (!p.html) { failed.push(p); continue; }
      const text = decode(p.html);
      const h1 = p.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const contract = h1 ? decode(h1[1]).trim() : p.url.split('/').pop();
      for (const hit of findNames(text, kw)) {
        const name = text.slice(hit.start, hit.end);
        if (records.some((r) => r.name === name && r.contract_url === p.url)) continue;
        const abnM = text.slice(hit.end, hit.end + 200).match(/ABN:?\s*([\d ]{9,14})/i);
        records.push({
          name,
          contract,
          contract_url: p.url,
          abn: abnM ? abnM[1].trim() : '',
          excerpt: text.slice(Math.max(0, hit.start - 60), hit.end + 160).trim(),
        });
      }
    }

    if (records.length) {
      return answer('found', '', records[0].contract_url, records[0].excerpt, records);
    }
    if (failed.length) {
      // A page that could not be read might have named the company, so this is never not_found.
      const order = ['blocked', 'timeout', 'http_error', 'other'];
      const worst = failed.slice().sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
      return answer('couldnt_check', worst.reason, worst.url,
        `${failed.length} of ${slugs.length} contract pages could not be read (${worst.excerpt}); the company is not named on the rest`);
    }
    return answer('not_found', '', LIST_URL,
      `checked ${slugs.length} contract and panel pages linked from this list; "${kwName}" is not named on any. ` +
      'The goods and services and construction registers are not searched: their supplier lists are not on this site.');
  } catch (err) {
    return answer('couldnt_check', 'other', LIST_URL, String(err?.message || err).slice(0, 300));
  }
}
