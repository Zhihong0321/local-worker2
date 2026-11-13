export const meta = {
  task: 'MY-semakmule.rmp.gov.my',
  want: 'w1',
  tier: 2,
  method: 'post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'report_date'],
  canary: { found: 'OSCAR GLOBAL TRADING SDN BHD', not_found: 'SYARIKAT TIADA REKOD ZXQW SDN BHD' },
};

// The SemakMule page (React app) sends this JSON POST for a company-name search. Captcha is switched off on the site
// (config.js: disableCaptcha = true), and the search answers without any key or cookie. The site matches the name with
// LIKE %term%, case-insensitive, and returns every match with no cap (checked: "SDN" returns 8,511 rows).
const SEARCH_URL = 'https://semakmule.rmp.gov.my/api/mule/get_search_data.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORM = new Set(['SDN', 'BHD', 'BERHAD', 'SENDIRIAN']);

/** Comparison key: upper case, punctuation and spacing removed, legal-form words removed. "VMEN TRADING SDN. BHD." -> "VMEN TRADING". */
function keyOf(name) {
  return String(name || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_FORM.has(t))
    .join(' ');
}

/** The text sent to the site: the name without the legal form, at least 3 characters (the site needs 3+). */
function searchTermOf(keyword) {
  const clean = (s) => String(s || '').normalize('NFKC').replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();
  const core = clean(
    clean(keyword)
      .replace(/\b(SDN|BHD|BERHAD|SENDIRIAN)\b\.?/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.,&\-/]+|[\s.,&\-/]+$/g, '')
  );
  if (core.length >= 3) return core;
  const full = clean(keyword);
  return full.length >= 3 ? full : null;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const term = searchTermOf(keyword);
    if (!term) {
      return couldnt('other', SEARCH_URL, 'the company name is too short to search (the site needs 3 or more characters)');
    }
    const want = keyOf(keyword);
    if (!want) {
      return couldnt('other', SEARCH_URL, 'no company name left after removing the legal form');
    }

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
      body: JSON.stringify({
        data: { category: 'namasyarikat', bankAccount: '', telNo: '', companyName: term, captcha: '', captchaHash: '' },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return couldnt('blocked', SEARCH_URL, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return couldnt('http_error', SEARCH_URL, `HTTP ${res.status}`);
    }

    // The site sends its JSON as text/html, so the body is parsed as text, not by content type.
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      const blockedPage = /captcha|cloudflare|access denied|attention required/i.test(text);
      return couldnt(blockedPage ? 'blocked' : 'layout_changed', SEARCH_URL, text.slice(0, 300));
    }
    if (!j || typeof j !== 'object') {
      return couldnt('layout_changed', SEARCH_URL, 'the search answer is not an object');
    }
    if (j.status !== 1) {
      const msg = String(j.status_message || '');
      const reason = /captcha|verif|robot|blocked|too many/i.test(msg) ? 'blocked' : 'other';
      return couldnt(reason, SEARCH_URL, `site status ${j.status}: ${msg}`);
    }

    // The answer must echo our search and carry the expected table, or the request was not understood (not a "not found").
    const header = Array.isArray(j.table_header) ? j.table_header : [];
    const rows = Array.isArray(j.table_data) ? j.table_data : null;
    const nameCol = header.findIndex((h) => /syarikat|company|nama/i.test(String(h)));
    const dateCol = header.findIndex((h) => /tarikh|date/i.test(String(h)));
    const echoed = typeof j.kw === 'string' && j.kw.toUpperCase().includes(term.toUpperCase());
    if (!rows || nameCol < 0 || !echoed || rows.some((r) => !Array.isArray(r))) {
      return couldnt('layout_changed', SEARCH_URL, `header ${JSON.stringify(header)}, kw ${JSON.stringify(j.kw)}`);
    }

    const matches = rows.filter((r) => keyOf(r[nameCol]) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: SEARCH_URL,
        excerpt: `search "${term}" returned ${rows.length} row(s); none matches "${keyword}" after normalising`,
      };
    }

    const records = matches.map((r) => ({
      name: String(r[nameCol] ?? '').trim(),
      report_date: dateCol >= 0 ? String(r[dateCol] ?? '').trim() : '',
    }));
    return {
      status: 'found',
      reason: '',
      records,
      source_url: SEARCH_URL,
      excerpt: `${records.length} report(s) for "${keyword}": ${records.map((r) => `${r.name} (${r.report_date})`).join('; ')}`,
    };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, SEARCH_URL, String(err?.message || err));
  }
}
