export const meta = {
  task: 'GB-find-and-update.company-information.service.gov.uk',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_number', 'status', 'date_line', 'address', 'previous_names', 'matched_on', 'matched_text', 'url'],
  canary: { found: 'TESCO PLC', not_found: 'XQZVN BLORFT HOLDINGS LIMITED' },
};

const BASE = 'https://find-and-update.company-information.service.gov.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&middot;/gi, '·')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Upper-case, drop punctuation, and split off the legal form (LTD / PLC / LLP). LIMITED = LTD, PUBLIC LIMITED COMPANY = PLC. */
function splitLegalForm(name) {
  const s = String(name || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/['’`]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/^THE /, '')
    .replace(/ PUBLIC LIMITED COMPANY$/, ' PLC')
    .replace(/ LIMITED LIABILITY PARTNERSHIP$/, ' LLP')
    .replace(/ LIMITED$/, ' LTD');
  const m = s.match(/^(.*) (LTD|PLC|LLP)$/);
  return m ? { core: m[1], form: m[2] } : { core: s, form: '' };
}

/** Same company: same core name, and the same legal form when the keyword gives one. */
function sameCompany(keyword, candidate) {
  const k = splitLegalForm(keyword);
  const c = splitLegalForm(candidate);
  if (!k.core || k.core !== c.core) return false;
  return k.form === '' || k.form === c.form;
}

/** Returns null when the page has no results list (layout changed), otherwise the list of companies on page 1. */
function parseList(html) {
  const ul = html.match(/<ul id=['"]results['"][\s\S]*?<\/ul>/);
  if (!ul) return null;
  const items = ul[0].match(/<li class="type-company">[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const li of items) {
    const link = li.match(/<a class="govuk-link" href="\/company\/([A-Za-z0-9]+)"[\s\S]*?>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const crumb = li.match(/<p class="meta crumbtrail">([\s\S]*?)<\/p>/);
    const crumbText = crumb ? decode(crumb[1]) : '';
    const addressP = li.match(/<p>([\s\S]*?)<\/p>/);
    const prev = li.match(/Matching previous names:[\s\S]*?<span>([\s\S]*?)<\/span>/);
    out.push({
      name: decode(link[2]),
      company_number: link[1],
      date_line: crumbText.replace(/^[A-Za-z0-9]+\s*-\s*/, ''),
      address: addressP ? decode(addressP[1]) : '',
      previous_names: prev ? decode(prev[1]).split(/\s*·\s*/).filter(Boolean) : [],
      url: BASE + '/company/' + link[1],
      li: decode(li),
    });
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').replace(/\s+/g, ' ').trim();
  const searchUrl = `${BASE}/search/companies?q=${encodeURIComponent(kw)}`;
  if (!kw) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: `${BASE}/search/companies`, excerpt: 'empty company name' };
  }
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const hasResults = /<ul id=['"]results['"]/.test(html);
    if (!hasResults && /captcha|cf-chl|Just a moment|Access denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: html.slice(0, 200) };
    }

    const list = parseList(html);
    if (list === null) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: decode(html).slice(0, 300) };
    }

    const records = [];
    for (const c of list) {
      const names = [{ text: c.name, via: 'name' }, ...c.previous_names.map((p) => ({ text: p, via: 'previous_name' }))];
      const hit = names.find((n) => sameCompany(kw, n.text));
      if (!hit) continue;
      records.push({
        name: c.name,
        company_number: c.company_number,
        status: /dissolved/i.test(c.date_line) ? 'dissolved' : null,
        date_line: c.date_line,
        address: c.address,
        previous_names: c.previous_names,
        matched_on: hit.via,
        matched_text: hit.text,
        url: c.url,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `Search page 1 lists ${list.length} companies; none has the name "${kw}" (current or previous)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: list.find((c) => c.company_number === records[0].company_number).li.slice(0, 300),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
