export const meta = {
  task: 'TW-amcham.com.tw',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_zh', 'address', 'tel', 'industries', 'website', 'profile_url'],
  canary: { found: 'Lam Research Corporation', not_found: '不存在測試股份有限公司' },
};

const BASE = 'https://member.amcham.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en,zh-TW;q=0.8',
};
const EN_LEGAL = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'ltd', 'limited', 'llc', 'plc',
  'llp', 'lp', 'gmbh', 'sdn', 'bhd', 'pte', 'pty', 'sa', 'srl', 'the']);
const ZH_LEGAL = /股份有限公司|有限公司|股份有限|有限|公司/g;
const CJK = /[㐀-鿿豈-﫿]/;
const MAX_PROFILES = 40;

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d{1,7});/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: case, punctuation and legal form removed (English and Chinese). */
function normName(s) {
  const t = String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return t.split(/\s+/).filter((w) => w && !EN_LEGAL.has(w)).join('').replace(ZH_LEGAL, '');
}

/** Search text: the name with legal-form words taken out, so "Lam Research Corporation" searches "Lam Research". */
function coreQuery(s) {
  const t = String(s || '').normalize('NFKC').replace(ZH_LEGAL, ' ');
  return t.split(/\s+/)
    .map((w) => w.replace(/[.,]+$/g, ''))
    .filter((w) => w && !EN_LEGAL.has(w.toLowerCase()))
    .join(' ')
    .trim();
}

function reasonOf(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

function result(status, reason, records, sourceUrl, excerpt) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

/** Result rows of a directory search: each listed company has a company_show block with an h3 link. */
function parseCandidates(html) {
  const out = [];
  const seen = new Set();
  for (const part of html.split('company_show').slice(1)) {
    const m = part.slice(0, 2000).match(/<h3[^>]*>\s*<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i);
    if (!m) continue;
    let u;
    try {
      u = new URL(decode(m[1]), BASE);
    } catch {
      continue;
    }
    if (!/(^|\.)amcham\.com\.tw$/i.test(u.hostname)) continue;
    u.search = '';
    u.hash = '';
    const name = clean(m[2]);
    if (name && !seen.has(u.href)) {
      seen.add(u.href);
      out.push({ url: u.href, name });
    }
  }
  return out;
}

/** Public company profile: English name, Chinese name, address, tel, industries, website. */
function parseProfile(html) {
  const block = (html.match(/class="desc_wrapper company-name"([\s\S]*?)<\/div>/i) || [])[1] || '';
  const nameEn = clean((block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]);
  const nameZh = clean((block.match(/<p class="subtitle"[^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
  const address = clean((html.match(/<b>Address:<\/b>([\s\S]*?)<\/p>/i) || [])[1]);
  const tel = clean((html.match(/<b>Tel:<\/b>([\s\S]*?)(?=<br|<b>|<\/p>)/i) || [])[1]);
  const indBlock = (html.match(/<p class="industries"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
  const industries = [...indBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => clean(m[1])).filter(Boolean).join('; ');
  const website = clean((html.match(/<b>Website:<\/b>\s*(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>|<\/p>)/i) || [])[1]);
  return { name_en: nameEn, name_zh: nameZh, address, tel, industries, website };
}

async function loadProfile(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'blocked', excerpt: `HTTP ${res.status} ${url}` };
    if (!res.ok) return { ok: false, reason: 'http_error', excerpt: `HTTP ${res.status} ${url}` };
    const p = parseProfile(await res.text());
    if (!p.name_en) return { ok: false, reason: 'layout_changed', excerpt: `no company name on ${url}` };
    return { ok: true, p };
  } catch (err) {
    return { ok: false, reason: reasonOf(err), excerpt: String(err?.message || err).slice(0, 200) };
  }
}

async function check(keyword) {
  const name = String(keyword || '').trim();
  let searchUrl = `${BASE}/directory`;
  try {
    const key = normName(name);
    if (!key) return result('couldnt_check', 'other', [], searchUrl, 'empty or unusable company name');

    const query = coreQuery(name) || name;
    searchUrl = `${BASE}/index.php?route=directory/search&filter_name=${encodeURIComponent(query)}&filter_type=company`;
    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return result('couldnt_check', 'blocked', [], searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return result('couldnt_check', 'http_error', [], searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (/captcha|cf-chl|just a moment|attention required/i.test(html)) {
      return result('couldnt_check', 'blocked', [], searchUrl, 'bot check or captcha page');
    }
    if (!/Results for/i.test(html)) {
      return result('couldnt_check', 'layout_changed', [], searchUrl, clean(html).slice(0, 300));
    }

    const candidates = parseCandidates(html);
    if (candidates.length === 0) {
      if (/No results found/i.test(html)) return result('not_found', '', [], searchUrl, `0 results for "${query}"`);
      return result('couldnt_check', 'layout_changed', [], searchUrl, clean(html).slice(0, 300));
    }

    // English listing names come straight from the results page. Chinese names only live on profile pages,
    // so those are loaded only when the keyword is Chinese and no English name matched.
    const exact = candidates.filter((c) => normName(c.name) === key);
    const hasCJK = CJK.test(name);
    const truncated = hasCJK && exact.length === 0 && candidates.length > MAX_PROFILES;
    const toLoad = exact.length ? exact : hasCJK ? candidates.slice(0, MAX_PROFILES) : [];

    const loaded = await Promise.all(toLoad.map((c) => loadProfile(c.url)));
    const profiles = new Map();
    const failures = [];
    toLoad.forEach((c, i) => {
      if (loaded[i].ok) profiles.set(c.url, loaded[i].p);
      else failures.push(loaded[i]);
    });

    const matches = candidates.filter((c) => {
      if (normName(c.name) === key) return true;
      const p = profiles.get(c.url);
      return !!p && [p.name_en, p.name_zh].some((n) => normName(n) === key);
    });

    if (matches.length > 0) {
      const records = matches.map((c) => {
        const p = profiles.get(c.url);
        return {
          name: p?.name_en || c.name,
          name_zh: p?.name_zh || '',
          address: p?.address || '',
          tel: p?.tel || '',
          industries: p?.industries || '',
          website: p?.website || '',
          profile_url: c.url,
        };
      });
      const r = records[0];
      return result('found', '', records, r.profile_url, `${r.name} | ${r.name_zh} | ${r.address}`);
    }

    if (failures.length > 0) {
      return result('couldnt_check', failures[0].reason, [], searchUrl, failures[0].excerpt);
    }
    if (truncated) {
      return result('couldnt_check', 'other', [], searchUrl, `${candidates.length} results; only the first ${MAX_PROFILES} checked`);
    }
    return result('not_found', '', [], searchUrl,
      `${candidates.length} listed, none matches "${name}" after normalising: ${candidates.map((c) => c.name).join('; ')}`);
  } catch (err) {
    return result('couldnt_check', reasonOf(err), [], searchUrl, String(err?.message || err));
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause before returning avoids a Node-on-Windows teardown crash (libuv assertion, exit 127) when the
 * worker's runner calls process.exit right after a single response.
 */
export default async function lookup(keyword) {
  const answer = await check(keyword);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}
