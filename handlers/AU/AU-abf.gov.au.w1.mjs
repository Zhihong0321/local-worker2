export const meta = {
  task: 'AU-abf.gov.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name'],
  canary: { found: 'Magellan Logistics Pty. Ltd.', not_found: 'Canva Pty Ltd' },
};

const PAGE = 'https://www.abf.gov.au/licensing/brokers/brokerages';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: String(excerpt || '').slice(0, 500) };
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ');
}

function norm(s) {
  return decode(String(s || ''))
    .toUpperCase()
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

    const res = await fetch(PAGE, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const html = await res.text();
    const head = html.slice(0, 1500).toLowerCase();
    if (
      res.status === 403 ||
      res.status === 429 ||
      head.includes('just a moment') ||
      head.includes('cf-browser-verification') ||
      head.includes('captcha')
    ) {
      return fail('blocked', `HTTP ${res.status} ${html.slice(0, 240)}`);
    }
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const start = html.indexOf('Brokerages list');
    const end = start >= 0 ? html.indexOf('ms-hide', start) : -1;
    if (start < 0 || end < 0 || !html.includes('This list is current as of') || !html.includes('customs brokers that may be authorised')) {
      return fail('layout_changed', html.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 300));
    }
    const slice = html.slice(start, end);
    const names = [...slice.matchAll(/<li>([^<]*)<\/li>/g)]
      .map((m) => decode(m[1]).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (names.length < 200) return fail('layout_changed', `brokerage list has ${names.length} names`);

    const hits = names.filter((name) => matches(q, name));
    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: 'Brokerages list: no matching customs brokerage' };
    }
    return {
      status: 'found',
      reason: '',
      records: hits.map((name) => ({ name })),
      source_url: PAGE,
      excerpt: hits.slice(0, 8).join('; ').slice(0, 500),
    };
  } catch (err) {
    const name = err && err.name;
    return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other', err && err.message);
  }
}
