export const meta = {
  task: 'MY-motac.gov.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_no', 'type', 'business_scope', 'period', 'address', 'phone'],
  canary: { found: 'LAVISH HOLIDAYS DMC SDN. BHD.', not_found: 'SYARIKAT PELANCONGAN TIADA WUJUD SDN BHD' },
};

// MOTAC "Semakan" > Agensi Pelancongan (TOBTAB) directory. The page's own search box calls this AJAX endpoint with a
// form POST; the reply is JSON whose `data.html` holds the result cards. No login, no nonce, no captcha.
const PAGE_URL = 'https://www.motac.gov.my/kategori-semakan-new/agensi-pelancongan-tobtab/';
const AJAX_URL = 'https://www.motac.gov.my/wp-admin/admin-ajax.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 100;    // the endpoint accepts up to 100 rows per page (checked 2026-11-13)
const MAX_PAGES = 10;    // at most 1000 rows per search variant
const START_NEW_REQUEST_BEFORE_MS = 30000; // worst case 30 s + one 25 s fetch stays under the 60 s limit

// Legal-form words. Used only to split a company name into "core" and "legal form" for comparison and for the
// fallback search, never to change what the site stores.
const LEGAL_WORDS = new Set(['SDN', 'BHD', 'BERHAD', 'SENDIRIAN', 'SDNBHD']);

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Split a name into its core words and its legal-form words, ignoring case and punctuation. */
function splitName(name) {
  const words = decode(name).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  let end = words.length;
  while (end > 1 && LEGAL_WORDS.has(words[end - 1])) end--;
  return { core: words.slice(0, end).join(' '), form: words.slice(end).join(' ') };
}

/** Same company: same core name, and the same legal form (or one of the two names has no legal form given). */
function sameCompany(typed, listed) {
  const a = splitName(typed);
  const b = splitName(listed);
  if (!a.core || a.core !== b.core) return false;
  return a.form === b.form || a.form === '' || b.form === '';
}

/** Search strings to try, in order: the name as typed, then without its legal form, then without punctuation. */
function queryVariants(typed) {
  const tokens = typed.split(' ');
  while (tokens.length > 1 && (tokens[tokens.length - 1].replace(/[^\p{L}\p{N}]/gu, '') === '' ||
         LEGAL_WORDS.has(tokens[tokens.length - 1].toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')))) {
    tokens.pop();
  }
  const withoutLegal = tokens.join(' ');
  const noPunct = splitName(typed).core;
  const out = [];
  for (const q of [typed, withoutLegal, noPunct]) {
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

function blockText(part, cls) {
  const m = part.match(new RegExp(`<div class="${cls}">([\\s\\S]*?)<\\/div>`));
  return m ? cleanText(m[1]) : '';
}

function parseCards(html) {
  return html.split('<div class="motac-card">').slice(1).map((part) => {
    const periodBlock = part.match(/<div class="col col-tempoh">([\s\S]*?)<\/div>/);
    const spans = periodBlock ? [...periodBlock[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => cleanText(m[1])) : [];
    return {
      name: blockText(part, 'company-name'),
      address: blockText(part, 'company-address'),
      phone: blockText(part, 'company-phone'),
      licence_no: blockText(part, 'col col-lesen'),
      business_scope: blockText(part, 'badge-bidang'),
      type: blockText(part, 'col col-jenis'),
      period: spans.filter(Boolean).join(' '),
    };
  });
}

const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 500) });

/** One search page. Returns { ok: true, total, cards } or { ok: false, reason, excerpt }. */
async function searchPage(query, page) {
  let res;
  try {
    res = await fetch(AJAX_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': PAGE_URL,
        'Origin': 'https://www.motac.gov.my',
      },
      body: new URLSearchParams({
        action: 'motac_semakan_filter',
        kategori: 'agensi-pelancongan-tobtab',
        search: query,
        negeri: '',
        klasifikasi: '',
        jenis: '',
        page: String(page),
        per_page: String(PER_PAGE),
      }).toString(),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /TIMEOUT/.test(err?.cause?.code || '');
    const cause = err?.cause ? ` [${err.cause.code || err.cause.name || ''} ${err.cause.message || ''}]` : '';
    return { ok: false, reason: timeout ? 'timeout' : 'other', excerpt: `${err?.name || 'Error'}: ${err?.message || err}${cause}` };
  }

  const text = await res.text().catch(() => '');
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status}` };
  if (/captcha|cf-chl|Just a moment/i.test(text)) return { ok: false, reason: 'blocked', excerpt: text.slice(0, 200) };

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'layout_changed', excerpt: 'search reply is not JSON: ' + text.slice(0, 200) };
  }
  if (json?.success !== true) {
    return { ok: false, reason: 'other', excerpt: 'site reported an error: ' + cleanText(String(json?.data?.html || json?.data || '')).slice(0, 200) };
  }

  const data = json.data || {};
  if (typeof data.html !== 'string') return { ok: false, reason: 'layout_changed', excerpt: 'no html in search reply' };
  const total = Number(String(data.total ?? '').replace(/,/g, ''));
  if (!Number.isFinite(total)) return { ok: false, reason: 'layout_changed', excerpt: 'no total in search reply' };

  const cards = parseCards(data.html);
  const emptyMessage = data.html.includes('Tiada rekod dijumpai');
  if (cards.length === 0 && !emptyMessage) return { ok: false, reason: 'layout_changed', excerpt: data.html.slice(0, 200) };
  if (cards.length > 0 && cards.some((c) => !c.name || !c.licence_no)) {
    return { ok: false, reason: 'layout_changed', excerpt: 'result card without name or licence number' };
  }
  return { ok: true, total, cards };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node on Windows can abort (exit 127, "UV_HANDLE_CLOSING") when the runner calls process.exit() while the
  // keep-alive sockets of these fetches are still closing. A short pause lets them close first.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  const typed = String(keyword ?? '').trim().replace(/\s+/g, ' ');
  if (!typed) return fail('other', 'empty company name');

  try {
    const records = [];
    const seen = new Set();
    const tried = [];
    let complete = true;

    for (const query of queryVariants(typed)) {
      let total = 0;
      let scanned = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (Date.now() - started > START_NEW_REQUEST_BEFORE_MS) { complete = false; break; }
        const r = await searchPage(query, page);
        if (!r.ok) return fail(r.reason, `${r.excerpt} (search "${query}", page ${page})`);
        total = r.total;
        scanned += r.cards.length;
        for (const c of r.cards) {
          if (!sameCompany(typed, c.name)) continue;
          const key = `${c.licence_no}|${c.type}|${c.name}`;
          if (!seen.has(key)) { seen.add(key); records.push(c); }
        }
        if (r.cards.length === 0 || scanned >= total) break;
        if (page === MAX_PAGES) complete = false;
      }
      if (scanned < total) complete = false;
      tried.push(`"${query}": ${total} rows`);
      if (records.length || !complete) break;
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: PAGE_URL,
        excerpt: records.map((r) => `${r.name} | ${r.licence_no} | ${r.type} | ${r.period}`).join(' ; ').slice(0, 500),
      };
    }
    if (!complete) {
      return fail('other', `did not check every search result before the time limit (${tried.join(', ')})`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `TOBTAB directory search answered normally (${tried.join(', ')}); no listed company matches "${typed}"`,
    };
  } catch (err) {
    return fail('other', String(err?.message || err));
  }
}
