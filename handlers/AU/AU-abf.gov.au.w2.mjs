export const meta = {
  task: 'AU-abf.gov.au',
  want: 'w2',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: ['name', 'type', 'abn'],
  canary: { found: 'Magellan Logistics Pty. Ltd.', not_found: 'Canva Pty Ltd' },
};

const PAGE = 'https://www.abf.gov.au/about-us/what-we-do/trustedtrader/accredited-trusted-traders';
const API = 'https://www.abf.gov.au/_layouts/15/api/Data.aspx/GetAccreditTradersData';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: String(excerpt || '').slice(0, 500) };
}

function norm(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/&AMP;/g, ' ')
    .replace(/&/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\b(PROPRIETARY|PTY|LTD|LIMITED|INCORPORATED|INC)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return false;
  if (q === n) return true;
  const shorter = q.length <= n.length ? q : n;
  const longer = q.length <= n.length ? n : q;
  if (shorter.length < 8) return false;
  const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?: |$)`).test(longer);
}

export default async function lookup(keyword) {
  try {
    const q = String(keyword ?? '').trim();
    if (!q) return fail('other', 'empty company name');

    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
      },
      body: '{}',
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    const head = text.slice(0, 800).toLowerCase();
    if (
      res.status === 403 ||
      res.status === 429 ||
      head.includes('just a moment') ||
      head.includes('cf-browser-verification') ||
      head.includes('captcha')
    ) {
      return fail('blocked', `HTTP ${res.status} ${text.slice(0, 240)}`);
    }
    if (!res.ok) return fail('http_error', `HTTP ${res.status} ${text.slice(0, 180)}`);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return fail('layout_changed', text.slice(0, 240));
    }
    const data = json && json.d && json.d.data;
    if (!json?.d?.success || !Array.isArray(data) || data.length < 100 || !data[0] || typeof data[0].nametext !== 'string') {
      return fail('layout_changed', text.slice(0, 240));
    }

    const hits = data.filter((row) => matches(q, row.nametext));
    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: 'Accredited Trusted Traders: no matching agreement' };
    }
    const records = hits.map((row) => ({
      name: String(row.nametext).replace(/\s+/g, ' ').trim(),
      type: String(row.type || '').trim(),
      abn: String(row.abntext || '').replace(/\D/g, ''),
    }));
    const excerpt = records
      .slice(0, 6)
      .map((r) => `${r.name} (${r.type}, ABN ${r.abn})`)
      .join('; ')
      .slice(0, 500);
    return { status: 'found', reason: '', records, source_url: PAGE, excerpt };
  } catch (err) {
    const name = err && err.name;
    return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other', err && err.message);
  }
}
