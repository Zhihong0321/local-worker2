export const meta = { task: 'TH-thairiceexporters.or.th', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'managing_director', 'contact', 'email', 'website', 'member_no', 'list_page'],
  canary: { found: 'Aden International Co.,Ltd.', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' } };

// The site's English member list is 11 plain HTML pages (member_1.htm ... member_11.htm, about 160 members).
// Its HTTPS certificate is issued to another host name, so HTTPS fails at connection level; the same public list is
// served over plain HTTP, and the handler falls back to that. No credentials, no forms, no captcha.
const HTTPS_BASE = 'https://thairiceexporters.or.th/';
const HTTP_BASE = 'http://thairiceexporters.or.th/';
const PAGES = Array.from({ length: 11 }, (_, i) => `member_${i + 1}.htm`);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Words that only say what kind of company it is; removed before comparing names.
const LEGAL_WORDS = ['co', 'company', 'ltd', 'limited', 'pcl', 'public', 'plc', 'sdn', 'bhd', 'inc', 'corp', 'corporation',
  'coop', 'cooperative', 'operative'];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: lower case, no punctuation, no legal form, no spaces. */
function core(name) {
  let s = decodeEntities(name).toLowerCase().replace(/&/g, ' ');
  s = s.replace(/บริษัท|จำกัด|มหาชน/g, ' ');
  // \p{M} keeps Thai vowel and tone marks inside words
  const tokens = s.split(/[^\p{L}\p{M}\p{N}]+/u).filter((t) => t && !LEGAL_WORDS.includes(t));
  return tokens.join('');
}

function parseRows(html) {
  const out = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanText);
    if (cells.length >= 3 && /^\d+\.?$/.test(cells[0]) && cells[1]) {
      const rest = cells.slice(3).filter(Boolean).join(' | ');
      const email = (cells.join(' ').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/) || [''])[0];
      const website = (rest.match(/(?:https?:\/\/)?(?:www\.)[^\s|]+/i) || [''])[0];
      out.push({
        member_no: cells[0].replace(/\.$/, ''),
        name: cells[1],
        managing_director: cells[2],
        contact: rest,
        email,
        website,
      });
    }
  }
  return out;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, reason: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { url, reason: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    if (!/Managing Director/i.test(html)) return { url, reason: 'layout_changed', detail: cleanText(html).slice(0, 300) };
    const rows = parseRows(html).map((r) => ({ ...r, list_page: url }));
    if (rows.length === 0) return { url, reason: 'layout_changed', detail: 'no numbered member rows: ' + cleanText(html).slice(0, 300) };
    return { url, rows };
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { url, reason: timeout ? 'timeout' : 'other', detail: String(e?.cause?.code || e?.message || e).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const firstUrl = HTTPS_BASE + PAGES[0];
  try {
    const key = core(keyword);
    if (!key) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
               excerpt: 'the name has no company words left after removing the legal form' };
    }

    // Probe HTTPS once; only a connection-level failure (certificate, TLS, network) switches the whole run to HTTP.
    let base = HTTPS_BASE;
    try {
      await fetch(firstUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      base = HTTP_BASE;
    }

    const pages = await Promise.all(PAGES.map((p) => fetchPage(base + p)));
    const rows = pages.flatMap((p) => p.rows || []);
    const matches = rows.filter((r) => core(r.name) === key);

    if (matches.length > 0) {
      return {
        status: 'found', reason: '',
        records: matches.map(({ name, managing_director, contact, email, website, member_no, list_page }) =>
          ({ name, managing_director, contact, email, website, member_no, list_page })),
        source_url: matches[0].list_page,
        excerpt: `${matches[0].member_no}. ${matches[0].name} | ${matches[0].contact}`.slice(0, 500),
      };
    }

    // Not found is only said when every list page was read; a failed page could hold the name.
    const failed = pages.find((p) => p.reason);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.url,
               excerpt: `${failed.url}: ${failed.detail}`.slice(0, 500) };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: base + PAGES[0],
      excerpt: `Read ${pages.length} member list pages with ${rows.length} members; no name matches "${keyword}"`.slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: firstUrl,
             excerpt: String(err?.message || err).slice(0, 500) };
  }
}
