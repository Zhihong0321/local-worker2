export const meta = {
  task: 'VN-careerlink.vn',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'size', 'company_url'],
  canary: { found: 'CÔNG TY TNHH NITTO DENKO VIỆT NAM', not_found: 'CÔNG TY TNHH ZQXVWK BDNRTL' },
};

const BASE = 'https://www.careerlink.vn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'vi,en;q=0.8' };

// Legal-form words, removed from both sides before comparing names.
const LEGAL_RE = /\b(trach nhiem huu han|mot thanh vien|co phan|cong ty|tnhh|ctcp|cp|cty|mtv|ltd|limited|jsc|corp|company|inc|pte|sdn|bhd|llc|gmbh|co)\b/g;
// Words left out of the search box only (the site search misses when they are typed).
const DROP = new Set(['cong', 'ty', 'tnhh', 'co', 'cp', 'ctcp', 'cty', 'mtv', 'ltd', 'limited', 'jsc', 'corp', 'company',
  'inc', 'pte', 'sdn', 'bhd', 'llc', 'gmbh', 'vietnam', 'viet', 'nam', 'vn', 'trach', 'nhiem', 'huu', 'phan']);

function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/** Comparison key: accents, case, punctuation and legal form removed. */
function companyKey(name) {
  const s = fold(name).replace(/[^a-z0-9]+/g, ' ').trim().replace(LEGAL_RE, ' ');
  return s.replace(/[^a-z0-9]/g, '');
}

function buildQuery(keyword) {
  const words = (keyword || '').split(/\s+/).filter((w) => {
    const n = fold(w).replace(/[^a-z0-9]/g, '');
    return n && !DROP.has(n);
  });
  return words.join(' ').replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim() || (keyword || '').trim();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company profile links on a search page: /viec-lam-cua/<slug>/<id>, with the company name. */
function companyLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="\/viec-lam-cua\/([^"\/?#]+)\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const [whole, slug, id, inner] = m;
    if (seen.has(id)) continue;
    const title = (whole.match(/\btitle="([^"]+)"/) || [])[1];
    const alt = (inner.match(/\balt="([^"]+)"/) || [])[1];
    const name = decodeEntities(title || cleanText(inner) || alt || '').trim();
    if (!name) continue;
    seen.add(id);
    out.push({ name, url: `${BASE}/viec-lam-cua/${slug}/${id}` });
  }
  return out;
}

/** One GET. Never throws: returns { kind: 'ok', html } or { kind: 'fail', reason, excerpt }. */
async function getPage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { kind: 'fail', reason: 'blocked', excerpt: `HTTP ${res.status}` };
    if (!res.ok) return { kind: 'fail', reason: 'http_error', excerpt: `HTTP ${res.status}` };
    const html = await res.text();
    const title = (html.match(/<title>([^<]*)/i) || [])[1] || '';
    if (/just a moment|attention required|captcha/i.test(title)) return { kind: 'fail', reason: 'blocked', excerpt: title.slice(0, 120) };
    return { kind: 'ok', html };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { kind: 'fail', reason: timeout ? 'timeout' : 'other', excerpt: String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: (excerpt || '').slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    const key = companyKey(keyword);
    if (!key) return out('couldnt_check', 'other', [], '', `no company name in "${keyword}"`);
    const query = buildQuery(keyword);
    const params = new URLSearchParams({ keyword: query }).toString();
    const empUrl = `${BASE}/nha-tuyen-dung-hang-dau?${params}`;
    const jobUrl = `${BASE}/vieclam/tim-kiem-viec-lam?${params}`;

    // Step 1: the featured-employer directory (only a subset of companies).
    const emp = await getPage(empUrl);
    if (emp.kind !== 'ok') return out('couldnt_check', emp.reason, [], empUrl, emp.excerpt);
    if (!emp.html.includes('employer-search-form')) return out('couldnt_check', 'layout_changed', [], empUrl, emp.html.slice(0, 300));
    let matches = companyLinks(emp.html).filter((c) => companyKey(c.name) === key);
    let searchUrl = empUrl;

    // Step 2: job search results, which name the company on each card.
    if (!matches.length) {
      if (elapsed() >= 30000) return out('couldnt_check', 'timeout', [], empUrl, 'job search skipped to stay under 60 s');
      const job = await getPage(jobUrl);
      if (job.kind !== 'ok') return out('couldnt_check', job.reason, [], jobUrl, job.excerpt);
      if (!/tim-kiem-viec-lam|JobIndex/.test(job.html)) return out('couldnt_check', 'layout_changed', [], jobUrl, job.html.slice(0, 300));
      matches = companyLinks(job.html).filter((c) => companyKey(c.name) === key);
      searchUrl = jobUrl;
      if (!matches.length) {
        return out('not_found', '', [], jobUrl, `no company matching "${query}" in the featured-employer search or the job search`);
      }
    }

    // Step 3: company profile page for address and size.
    const records = [];
    for (const c of matches.slice(0, 2)) {
      if (records.length && elapsed() >= 30000) break;
      const p = await getPage(c.url);
      if (p.kind !== 'ok') {
        records.push({ name: c.name, address: '', size: '', company_url: c.url });
        continue;
      }
      const h1 = (p.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
      const addrBlock = ((p.html.match(/__address"[\s\S]*?<\/div>/) || [''])[0]).replace(/^[^>]*>/, '');
      const headerText = cleanText(p.html.slice(p.html.indexOf('CompanyPortalHeader'), p.html.indexOf('CompanyPortalHeader') + 4000));
      const size = (headerText.match(/([\d.,]+\s*-\s*[\d.,]+\s*nhân viên|[\d.,]+\+?\s*nhân viên)/i) || [])[1] || '';
      records.push({
        name: h1 ? cleanText(h1) : c.name,
        address: cleanText(addrBlock),
        size,
        company_url: c.url,
      });
    }

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.company_url,
      excerpt: `${first.name} | ${first.address} | ${searchUrl}`.slice(0, 500),
    };
  } catch (err) {
    return out('couldnt_check', 'other', [], '', String(err && err.message ? err.message : err));
  }
}
