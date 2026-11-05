export const meta = {
  task: 'MY-legaldirectory.malaysianbar.org.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'status', 'state', 'city', 'address', 'postcode', 'phone', 'fax', 'website', 'email', 'aop', 'lawyer_count'],
  canary: { found: 'Skrine', not_found: 'Dezeno' },
  pdf: false,
};

const API = 'https://legaldirectory.malaysianbar.org.my/a/Lawyer/getSearchResult';
const PAGE = 'https://legaldirectory.malaysianbar.org.my/v/search-result';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STOP = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'the', 'and', 'inc', 'ltd', 'limited', 'co', 'company', 'corporation', 'plc', 'llp', 'of', 'a', 'an']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, ' & ')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s) {
  return norm(s)
    .replace(/&/g, ' ')
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}

function clean(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function endpoint(keyword, page) {
  return (
    API +
    '?aop_filter=&name=' + encodeURIComponent(keyword) +
    '&alphabet=&searchtype%5B%5D=Firm&state=&city=&keyword=&page=' + page
  );
}

async function searchPage(keyword, page) {
  const url = endpoint(keyword, page);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/javascript, */*; q=0.01' },
    redirect: 'follow',
  });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + ' on ' + url);
    e.code = 'http_error';
    throw e;
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const firms = json && json.data && json.data.firms;
  if (!json || json.status !== 1 || !firms || !Array.isArray(firms.data) || firms.numrow === undefined) {
    const e = new Error('result markers missing, body starts: ' + text.slice(0, 120));
    e.code = 'layout_changed';
    throw e;
  }
  return { firms, url };
}

function toRecord(f) {
  const aop = Array.isArray(f.aoplist) ? f.aoplist.map((x) => clean(x && x.name)).filter(Boolean).join('; ') : '';
  return {
    name: clean(f.name),
    status: clean(f.firm_status || f.status),
    state: clean(f.state),
    city: clean(f.city),
    address: [clean(f.add1), clean(f.add2), clean(f.add3)].filter(Boolean).join(', '),
    postcode: clean(f.postcode),
    phone: [clean(f.tel1), clean(f.tel2)].filter(Boolean).join(' / '),
    fax: clean(f.fax),
    website: clean(f.website),
    email: clean(f.email),
    aop,
    lawyer_count: Array.isArray(f.lawyerlist) ? f.lawyerlist.length : 0,
  };
}

function matches(f, wantTokens) {
  if (!wantTokens.length) return false;
  const hay = ' ' + norm(f.name) + ' ';
  return wantTokens.every((t) => hay.includes(' ' + t));
}

function line(r) {
  return `${r.name} | ${r.status} | ${r.city}, ${r.state} | ${r.address} ${r.postcode} | tel ${r.phone} | ${r.email} | ${r.website} | aop: ${r.aop || '-'} | ${r.lawyer_count} lawyers`;
}

export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const wantTokens = tokens(kw);
  if (!wantTokens.length) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'empty company name' };
  }

  let page = 1;
  let seen = 0;
  let total = 0;
  let lastUrl = endpoint(kw, 1);
  const hits = [];

  try {
    while (page <= 5) {
      const got = await searchPage(kw, page);
      lastUrl = got.url;
      total = Number(got.firms.numrow) || 0;
      seen += got.firms.data.length;
      for (const f of got.firms.data) if (matches(f, wantTokens)) hits.push(toRecord(f));
      if (hits.length || seen >= total || got.firms.data.length === 0) break;
      page += 1;
      await sleep(1100);
    }
  } catch (err) {
    const reason =
      err && err.code === 'layout_changed' ? 'layout_changed'
        : err && err.code === 'http_error' ? 'http_error'
          : err && err.name === 'TimeoutError' ? 'timeout'
            : 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: lastUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }

  if (hits.length) {
    return {
      status: 'found',
      reason: '',
      records: hits,
      source_url: lastUrl,
      excerpt: hits.map(line).join(' ;; ').slice(0, 500),
    };
  }

  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl,
    excerpt: `Malaysian Bar legal directory, firm search for "${kw}": ${total} firm name(s) matched, none of them is "${kw}".`,
  };
}
