export const meta = {
  task: 'CH-moneyhouse.ch',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'uid', 'legal_form', 'status', 'address', 'seat', 'register_number', 'registry_office', 'entry_date', 'company_url', 'matched_by'],
  canary: { found: 'Nestlé S.A.', not_found: 'Quarzitwerk Zyklopenhof Gletscher GmbH' },
};

const BASE = 'https://www.moneyhouse.ch';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' };
const PAGE_LIMIT = 50;      // the site returns at most 50 rows per query (limit:50 in the page's own search request)
const MAX_DETAIL = 5;       // company pages read for the register fields; the rest keep the search-row fields
const LEGAL_FORMS = ['sa', 'ag', 'gmbh', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'srl', 'plc', 'kg'];
const STATUS = { active: 'active', liquidation: 'in liquidation' };

/** Lower case, no accents, no punctuation, legal forms joined ("S.A." -> "sa"), "in liquidation" dropped. */
function canon(s) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/\bin liquidation\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/\bs a r l\b/g, 'sarl').replace(/\bs a g l\b/g, 'sagl').replace(/\bg m b h\b/g, 'gmbh').replace(/\bs a\b/g, 'sa');
  return t.replace(/\s+/g, ' ').trim();
}

function hasLegalForm(full) {
  const parts = full.split(' ');
  return parts.length > 1 && LEGAL_FORMS.includes(parts[parts.length - 1]);
}

function baseName(full) {
  const parts = full.split(' ');
  while (parts.length > 1 && LEGAL_FORMS.includes(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** 'exact' when the full normalised names are equal; a keyword without legal form also matches any legal form. */
function matchBy(kwFull, recFull) {
  if (!kwFull || !recFull) return null;
  if (recFull === kwFull) return 'exact';
  if (!hasLegalForm(kwFull) && baseName(recFull) === kwFull) return 'name_without_legal_form';
  return null;
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function clean(html) {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company rows of the search page. Only the companies block, and never the "toplist" suggestions. */
function parseCompanyRows(html) {
  const start = html.indexOf('id="companies"');
  if (start < 0) return null;
  let end = html.indexOf('id="persons"', start + 1);
  if (end < 0) end = html.length;
  const section = html.slice(start, end);
  const counts = section.match(/(\d+) result \(of total (\d+)\)/);
  const rows = [];
  for (const chunk of section.split(/<tr[\s>]/).slice(1)) {
    const m = chunk.match(/<div class="row-person-data[^"]*"[^>]*>\s*<a href="(\/en\/company\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>\s*<div class="section--small">\s*<p class="minor">([\s\S]*?)<\/p>/);
    if (!m || /toplist/.test(m[2])) continue;
    const icon = chunk.match(/icon-company_([a-z_]+)/);
    rows.push({ href: m[1], name: clean(m[3]), address: clean(m[4]), status: icon ? icon[1] : '' });
  }
  return { rows, shown: counts ? Number(counts[1]) : rows.length, siteCount: counts ? counts[0] : '' };
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Adds the register fields from the company page. A failed page keeps the search-row fields. */
async function enrich(h) {
  const rec = {
    name: h.name, uid: '', legal_form: '', status: STATUS[h.status] || h.status, address: h.address, seat: '',
    register_number: '', registry_office: '', entry_date: '', company_url: BASE + h.href, matched_by: h.matched_by,
  };
  try {
    const res = await fetch(rec.company_url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return rec;
    const html = await res.text();
    const field = (label) => {
      const m = html.match(new RegExp(`<h4 class="key">${label}</h4>\\s*<p class="(?:value|val)">([\\s\\S]*?)</p>`));
      return m ? clean(m[1]) : '';
    };
    rec.uid = (field('UID/VAT').match(/CHE-[\d.]+/) || [''])[0];
    rec.legal_form = field('Legal form');
    rec.seat = field('Legal headquarters of the company');
    rec.register_number = field('Commercial register number');
    rec.registry_office = field('Commercial Registry Office');
    rec.entry_date = field('Entry in the commercial register');
    return rec;
  } catch {
    return rec;
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = `${BASE}/en/search?q=${encodeURIComponent(kw)}`;
  try {
    const kwFull = canon(kw);
    if (!kwFull) return fail('other', searchUrl, 'empty company name');

    const res = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return fail('blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    const parsed = parseCompanyRows(html);
    if (!parsed) {
      if (/captcha|challenge-platform|Just a moment/i.test(html)) return fail('blocked', searchUrl, 'bot check page');
      return fail('layout_changed', searchUrl, html.slice(0, 300));
    }

    const hits = [];
    for (const r of parsed.rows) {
      const how = matchBy(kwFull, canon(r.name));
      if (how) hits.push({ ...r, matched_by: how });
    }

    if (!hits.length) {
      if (parsed.rows.length >= PAGE_LIMIT) {
        return fail('other', searchUrl, `${PAGE_LIMIT} rows on one page and no name match; the company may be further on`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `Moneyhouse shows ${parsed.rows.length} company rows for "${kw}", none with this name. ${parsed.siteCount}`.trim(),
      };
    }

    const records = await Promise.all(hits.map((h, i) => (i < MAX_DETAIL ? enrich(h) : Promise.resolve({
      name: h.name, uid: '', legal_form: '', status: STATUS[h.status] || h.status, address: h.address, seat: '',
      register_number: '', registry_office: '', entry_date: '', company_url: BASE + h.href, matched_by: h.matched_by,
    }))));

    return {
      status: 'found', reason: '', records, source_url: searchUrl,
      excerpt: `${hits.length} matching compan${hits.length === 1 ? 'y' : 'ies'} on Moneyhouse for "${kw}": ${hits.map((h) => h.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
