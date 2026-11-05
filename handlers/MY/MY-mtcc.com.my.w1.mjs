export const meta = {
  task: 'MY-mtcc.com.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'cert_no', 'licence_no', 'cert_body', 'cert_type', 'status', 'expiry', 'website', 'address'],
  canary: { found: 'Zedtee Plywood Sdn. Bhd.', not_found: 'O2O Digital' },
};

const LIST_URL = 'https://mtcc.com.my/find-certified-companies/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MARKER = 'pods-companies-table';
const MIN_ROWS = 50;

let cache = null; // { at: ms, html: string }
let lastFetch = 0;

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function text(html) {
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function cell(row, label) {
  const re = new RegExp('<td[^>]*data-label="' + label + '"[^>]*>([\\s\\S]*?)<\\/td>', 'i');
  const m = row.match(re);
  return m ? text(m[1]) : '';
}

function parseRows(html) {
  const start = html.search(/<tbody/i);
  const end = html.search(/<\/tbody>/i);
  const body = start >= 0 && end > start ? html.slice(start, end) : '';
  const out = [];
  for (const row of body.split(/<tr\b/i).slice(1)) {
    const name = cell(row, 'Company');
    if (!name) continue;
    const st = row.match(/data-status="([^"]*)"/);
    out.push({
      name,
      cert_no: cell(row, 'Certificate Number'),
      licence_no: cell(row, 'License Number'),
      cert_body: cell(row, 'Certification Body'),
      cert_type: cell(row, 'Certificate Type'),
      status: st ? decode(st[1]).trim() : cell(row, 'Status'),
      expiry: cell(row, 'Expiry Date'),
      website: cell(row, 'Website'),
      address: cell(row, 'Address'),
    });
  }
  return out;
}

function normalize(s) {
  return decode(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEGAL = new Set(['sdn', 'bhd', 'berhad', 'sendirian', 'sdnbhd', 'pt', 'ltd', 'limited', 'inc', 'co', 'corp', 'company', 'enterprise', 'trading', 'the']);

function core(norm) {
  const t = norm.split(' ').filter(Boolean);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

async function getList() {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.html;
  const wait = lastFetch + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(LIST_URL, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(40000),
    redirect: 'follow',
  });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status);
    e.code = res.status === 403 || res.status === 503 ? 'blocked' : 'http_error';
    throw e;
  }
  const html = await res.text();
  cache = { at: Date.now(), html };
  return html;
}

/** Look one company up on the MTCC certified-companies register. Never throws. */
export default async function lookup(keyword) {
  const fail = (reason, src = LIST_URL, excerpt = '') => ({
    status: 'couldnt_check',
    reason,
    records: [],
    source_url: src,
    excerpt,
  });

  if (!keyword || !String(keyword).trim()) return fail('other', LIST_URL, 'empty keyword');

  let html;
  try {
    html = await getList();
  } catch (e) {
    const msg = String(e && e.message);
    if (e && e.code === 'blocked') return fail('blocked', LIST_URL, msg);
    if (/timeout|aborted/i.test(msg)) return fail('timeout', LIST_URL, msg);
    return fail('http_error', LIST_URL, msg);
  }

  if (/just a moment|cf-challenge|checking your browser|attention required/i.test(html.slice(0, 4000))) {
    return fail('blocked', LIST_URL, html.slice(0, 300));
  }

  const rows = parseRows(html);
  if (!html.includes(MARKER) || rows.length < MIN_ROWS) {
    return fail('layout_changed', LIST_URL, 'register table missing or has only ' + rows.length + ' rows');
  }

  const nk = normalize(keyword);
  const nkCore = core(nk);
  const tokens = nk.split(' ').filter((t) => t.length >= 3);

  const scored = [];
  for (const r of rows) {
    const nn = normalize(r.name);
    const nc = core(nn);
    let score = 0;
    if (nn === nk || nc === nkCore) score = 3;
    else if (nn.includes(nk) || (nk.length >= 4 && nk.includes(nn))) score = 2;
    else if (tokens.length > 0 && tokens.every((t) => nn.includes(t))) score = 1;
    if (score > 0) scored.push({ score, r });
  }

  const seen = new Set();
  const records = [];
  for (const { r } of scored) {
    const key = r.name + '|' + r.cert_no;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(r);
  }

  if (records.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LIST_URL,
      excerpt:
        'Searched ' + rows.length + ' rows on the MTCC certified-companies register for "' + keyword + '": no match.',
    };
  }

  const r0 = records[0];
  const excerpt = (
    r0.name + ' | certificate ' + r0.cert_no + ' (' + r0.cert_type + ') issued by ' + r0.cert_body +
    ' | licence ' + r0.licence_no + ' | status ' + r0.status + ' | expires ' + r0.expiry +
    (r0.address ? ' | ' + r0.address : '')
  ).slice(0, 500);

  return {
    status: 'found',
    reason: '',
    records,
    source_url: LIST_URL,
    excerpt,
  };
}
