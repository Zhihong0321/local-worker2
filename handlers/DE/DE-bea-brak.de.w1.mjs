export const meta = {
  task: 'DE-bea-brak.de',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'card_name', 'details'],
  canary: {
    found: 'AB Legal Advisory Rechtsanwaltsgesellschaft mbH',
    not_found: 'Qzxvwkpl Zyyxbnm Rechtsanwaltsgesellschaft mbH',
  },
};

// BRAK register (PrimeFaces / JSF). Search = a form POST of the "Law office" field with the page's ViewState.
const PAGE = 'https://bravsearch.bea-brak.de/bravsearch/index.xhtml';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words, ignored when comparing names.
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'kg', 'kgaa', 'ohg', 'gbr', 'ug', 'se', 'co', 'eg', 'ev', 'partg', 'mbb',
  'partnerschaft', 'partnerschaftsgesellschaft', 'rechtsanwaltsgesellschaft', 'rechtsanwaltsgmbh', 'rag']);

function tokens(s) {
  return String(s || '')
    .replace(/&/g, ' und ')
    .replace(/ß/g, 'ss').replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Comparison key: lower case, punctuation and spaces removed, legal form removed. */
function keyOf(s) {
  return tokens(s).filter((t) => !LEGAL.has(t)).join('');
}

/** The name as typed, minus the legal-form words (used as a second, broader search). */
function coreQuery(keyword) {
  return keyword.split(/\s+/).filter((w) => w && !LEGAL.has(tokens(w).join(''))).join(' ');
}

function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&uuml;/g, 'ü').replace(/&ouml;/g, 'ö').replace(/&auml;/g, 'ä').replace(/&szlig;/g, 'ß')
    .replace(/&Uuml;/g, 'Ü').replace(/&Ouml;/g, 'Ö').replace(/&Auml;/g, 'Ä')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

const fail = (reason, source_url, excerpt) =>
  ({ status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) });

async function call(url, init) {
  let res;
  let text;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      ...init,
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.8',
        ...(init.headers || {}),
      },
    });
    text = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'other', excerpt: String((e && e.message) || e).slice(0, 200) };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  if (/captcha/i.test(text)) return { ok: false, reason: 'blocked', excerpt: 'captcha page' };
  return { ok: true, res, text };
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function viewStateFrom(html) {
  const tag = html.match(/<input[^>]*name="jakarta\.faces\.ViewState"[^>]*>/);
  const value = tag && tag[0].match(/value="([^"]*)"/);
  return value ? value[1] : '';
}

/** Result cards: header = name as listed (person or law office), lines = the card's list items. */
function parseCards(html) {
  const cards = [];
  const parts = html.split('resultCardHeader').slice(1);
  for (const part of parts) {
    const header = clean(part.split('</span>')[0].replace(/^[^>]*>/, ''));
    let seg = part;
    const cut = seg.search(/Entries \d+ - \d+ of/);
    if (cut >= 0) seg = seg.slice(0, cut);
    const u = seg.indexOf('<ul>');
    const end = u >= 0 ? seg.indexOf('</ul>', u) : -1;
    const block = u >= 0 && end > u ? seg.slice(u, end) : '';
    const lines = [];
    for (const m of block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      const t = clean(m[1]);
      if (t) lines.push(t);
    }
    cards.push({ header, lines });
  }
  return cards;
}

/** One search: { none: true } | { ok: true, total, shown, cards } | { ok: false, reason, excerpt }. */
async function search(q) {
  // A fresh session for every search: the register keeps state between searches on one session.
  const get = await call(PAGE, { method: 'GET' });
  if (!get.ok) return { ok: false, reason: get.reason, excerpt: get.excerpt };
  const vs = viewStateFrom(get.text);
  if (!vs) return { ok: false, reason: 'layout_changed', excerpt: clean(get.text).slice(0, 300) };
  const cookie = cookiesFrom(get.res);

  const body = new URLSearchParams({
    'searchForm': 'searchForm',
    'searchForm:ddLanguage_input': 'en',
    'searchForm:txtOfficeName': q,
    'searchForm:cmdSearch': 'searchForm:cmdSearch',
    'jakarta.faces.ViewState': vs,
  });
  const post = await call(PAGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
    body: body.toString(),
  });
  if (!post.ok) return { ok: false, reason: post.reason, excerpt: post.excerpt };
  const html = post.text.replace(/<!--[\s\S]*?-->/g, '');
  // Result cards come first: the "no result" text can sit in the page template too.
  const totalMatch = html.match(/Number of result entries:\s*([\d.,]+)/);
  if (totalMatch && html.includes('resultCardHeader')) {
    const total = Number(totalMatch[1].replace(/[.,]/g, ''));
    const cards = parseCards(html);
    return { ok: true, total, shown: cards.length, cards };
  }
  if (html.includes('Your search query returned no result')) return { none: true };
  return { ok: false, reason: 'layout_changed', excerpt: clean(html).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const kw = String(keyword || '').trim().replace(/\s+/g, ' ');
    const key = keyOf(kw);
    if (!key) return fail('other', PAGE, 'no name left to search after removing the legal form');

    // 1. search the name as typed; then, if needed, without the legal form
    const queries = [kw];
    const core = coreQuery(kw);
    if (core && core.toLowerCase() !== kw.toLowerCase()) queries.push(core);

    let truncated = null;
    for (let i = 0; i < queries.length; i++) {
      if (i > 0 && Date.now() - started > 30000) return fail('timeout', PAGE, 'out of time before the second search');
      const q = queries[i];
      const r = await search(q);
      if (r.none) continue;
      if (!r.ok) return fail(r.reason, PAGE, r.excerpt);

      const hits = [];
      for (const card of r.cards) {
        const hit = keyOf(card.header) === key || card.lines.some((l) => keyOf(l) === key);
        if (hit) hits.push(card);
      }
      if (hits.length) {
        const note = r.shown < r.total ? ` Only the first ${r.shown} of ${r.total} entries were read.` : '';
        return {
          status: 'found',
          reason: '',
          records: hits.map((c) => ({
            name: keyOf(c.header) === key ? c.header : (c.lines.find((l) => keyOf(l) === key) || c.header),
            card_name: c.header,
            details: c.lines,
          })),
          source_url: PAGE,
          excerpt: `Search "${q}" (${r.total} entries).${note} ` + hits[0].header + ' | ' + hits[0].lines.join(' | '),
        };
      }
      if (r.shown < r.total) truncated = { q, shown: r.shown, total: r.total };
    }

    // 3. nothing matched
    if (truncated) {
      return fail('other', PAGE,
        `Search "${truncated.q}" returned ${truncated.total} entries; only the first ${truncated.shown} can be read ` +
        'and none of them is an exact match, so absence cannot be proven.');
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE,
      excerpt: `Register search returned no result for: ${queries.map((q) => `"${q}"`).join(', ')}`,
    };
  } catch (err) {
    return fail('other', PAGE, String((err && err.message) || err));
  }
}
