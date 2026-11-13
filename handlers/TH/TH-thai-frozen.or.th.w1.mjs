export const meta = {
  task: 'TH-thai-frozen.or.th',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'managing_director', 'office_address', 'factory_address', 'phone', 'email', 'website'],
  canary: { found: 'A & N FOODS CO., LTD.', not_found: 'บริษัท ทดสอบ ไม่มีอยู่จริง จำกัด' },
};

const BASE = 'https://www.thai-frozen.or.th';
const MEMBERS_URL = `${BASE}/TH/Member`;
const SEARCH_URL = `${BASE}/TH/Member/Search`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_MS = 25000;      // every fetch: 25 s, as the contract asks
const BUDGET_MS = 58000;     // the whole call must finish under 60 s
const PAGE_SIZE = 16;        // the search shows 16 members per page
const MAX_PAGES = 20;
const MAX_DETAILS = 5;
const LEGAL = new Set(['co', 'ltd', 'limited', 'public', 'pcl', 'plc', 'company', 'corp', 'corporation', 'inc', 'จำกัด', 'มหาชน']);
const THAI = /[฀-๿]/;
const MARKER = 'TFFA MEMBERS';

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(html) {
  return decode((html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Compare names: case, punctuation and legal form ignored; "&" read as "and". */
function norm(s) {
  return decode(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t))
    .join(' ');
}

/**
 * The word sent to the site search: the longest word of the name, without legal form or "&".
 * The site search misses spacing variants ("A&N" vs "A & N"), so one whole word is safer;
 * the exact name comparison below then decides the match.
 */
function searchTerm(keyword) {
  const words = keyword.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w && !LEGAL.has(w.toLowerCase()));
  let best = '';
  for (const w of words) {
    if (w.length > best.length) best = w;
  }
  return best || keyword.trim();
}

function parseCards(html) {
  const cards = [];
  const re = /<a href="\/TH\/Member\/Detail\/([^"?#]+)"(?:(?!<\/a>)[\s\S])*?<p class="head-mem-content">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    cards.push({ id: m[1], name: cleanText(m[2]) });
  }
  return cards;
}

function parseDetail(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? cleanText(m[1]) : '';
  };
  return {
    name: pick(/<p class="header-text-mem">([\s\S]*?)<\/p>/),
    managing_director: pick(/Managing Director:<br\s*\/?>([\s\S]*?)<\/p>/),
    office_address: pick(/<li>ที่อยู่สำนักงาน<\/li>\s*<p[^>]*>([\s\S]*?)<\/p>/),
    factory_address: pick(/<li>ที่อยู่โรงงาน<\/li>\s*<p[^>]*>([\s\S]*?)<\/p>/),
    phone: pick(/โทรศัพท์\s*:([^<]*)</),
    email: pick(/mailto:([^"]+)"/),
    website: pick(/Website(?:&nbsp;|\s)*:(?:&nbsp;|\s)*<a href="([^"]+)"/i),
  };
}

function looksBlocked(html) {
  return /captcha|cf-chl|Just a moment|Access denied|Attention Required/i.test(html || '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const timeLeft = () => Date.now() - started + FETCH_MS <= BUDGET_MS;
  const fail = (reason, excerpt) => ({
    status: 'couldnt_check', reason, records: [], source_url: MEMBERS_URL, excerpt: String(excerpt).slice(0, 300),
  });
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,th;q=0.8' };

  try {
    const kw = String(keyword ?? '').trim();
    if (!norm(kw)) return fail('other', 'empty company name');
    const want = norm(kw);
    const term = searchTerm(kw);

    // 1. The members page gives the anti-forgery token and the cookie the search needs.
    if (!timeLeft()) return fail('timeout', 'time budget used up before the search started');
    const page = await fetch(MEMBERS_URL, { headers, signal: AbortSignal.timeout(FETCH_MS) });
    if (page.status === 403 || page.status === 429) return fail('blocked', `HTTP ${page.status} on ${MEMBERS_URL}`);
    if (!page.ok) return fail('http_error', `HTTP ${page.status} on ${MEMBERS_URL}`);
    const pageHtml = await page.text();
    const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!tokenMatch || !pageHtml.includes(MARKER)) {
      return fail(looksBlocked(pageHtml) ? 'blocked' : 'layout_changed', 'members page has no search form or token');
    }
    const token = tokenMatch[1];
    const cookie = (typeof page.headers.getSetCookie === 'function' ? page.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');

    // 2. Search, page by page, until a page is not full.
    const matches = [];
    const seen = new Set();
    let total = 0;
    let pagesRead = 0;
    let lastPageFull = false;
    for (let p = 1; p <= MAX_PAGES; p++) {
      if (!timeLeft()) return fail('timeout', `stopped after ${pagesRead} result page(s) for "${term}"`);
      const body = new URLSearchParams({ __RequestVerificationToken: token, search: term, sort: '', category: '', CurrentPage: String(p) });
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': MEMBERS_URL, ...(cookie ? { Cookie: cookie } : {}) },
        body,
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status} on search page ${p}`);
      if (!res.ok) return fail('http_error', `HTTP ${res.status} on search page ${p}`);
      const html = await res.text();
      if (!html.includes(MARKER)) {
        return fail(looksBlocked(html) ? 'blocked' : 'layout_changed', `search page ${p} has no member list`);
      }
      pagesRead++;
      const cards = parseCards(html);
      for (const c of cards) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        total++;
        if (norm(c.name) === want) matches.push(c);
      }
      lastPageFull = cards.length >= PAGE_SIZE;
      if (!lastPageFull) break;
    }
    if (lastPageFull) {
      return fail('other', `"${term}" has more than ${MAX_PAGES * PAGE_SIZE} results; the rest were not read`);
    }

    // 3. Not listed: the site answered normally and no member has this name.
    if (matches.length === 0) {
      let excerpt = `Search "${term}" returned ${total} member(s); none has the name "${kw}".`;
      if (THAI.test(kw)) {
        excerpt += ' The directory lists English names only, so a Thai-script name can match only if its English name is listed.';
      }
      return { status: 'not_found', reason: '', records: [], source_url: MEMBERS_URL, excerpt };
    }

    // 4. Listed: read each matching member's detail page.
    const records = [];
    for (const m of matches.slice(0, MAX_DETAILS)) {
      const detailUrl = `${BASE}/TH/Member/Detail/${m.id}`;
      let rec = { name: m.name, managing_director: '', office_address: '', factory_address: '', phone: '', email: '', website: '' };
      if (timeLeft()) {
        try {
          const d = await fetch(detailUrl, { headers, signal: AbortSignal.timeout(FETCH_MS) });
          if (d.ok) {
            const detail = parseDetail(await d.text());
            rec = { ...rec, ...Object.fromEntries(Object.entries(detail).filter(([, v]) => v)) };
          }
        } catch {
          // keep the name from the search result; the match itself is proven
        }
      }
      records.push({ ...rec, detail_url: detailUrl });
    }
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.detail_url,
      excerpt: `${first.name}: ${[first.office_address, first.phone, first.email].filter(Boolean).join(' | ')}`.slice(0, 500),
    };
  } catch (err) {
    return fail('other', String(err?.message || err));
  }
}
