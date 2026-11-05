// Public per-company register linked from cybersecurity.my: ISCB's
// Penetration Test Service Provider certified-provider table.
export const meta = {
  task: 'MY-cybersecurity.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'address', 'phone', 'email', 'contact_person'],
  canary: { found: 'SysArmy Sdn Bhd', not_found: 'O2O Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const PAGE = 'https://iscb.cybersecurity.my/index.php/certification/management-system-certification/penetration-test/certified-provider';
const STOP = new Set(['SDN', 'BHD', 'MALAYSIA', 'THE', 'AND']);

let cache = null;
let cacheAt = 0;

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: String(excerpt || '').replace(/\s+/g, ' ').slice(0, 500) };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
}

function textOf(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
}

function norm(s) {
  return decodeEntities(s).toUpperCase().replace(/&/g, ' AND ')
    .replace(/\b(SDN\.?\s*BHD\.?|SENDIRIAN BERHAD|BERHAD|BHD\.?)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}

function matches(keyword, title) {
  const a = norm(keyword);
  const b = norm(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && (b.includes(a) || (b.length >= 5 && a.includes(b)))) return true;
  const ta = tokens(keyword);
  if (!ta.length || !ta.every((t) => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(b))) return false;
  return ta.length >= 2 || ta[0].length >= 4;
}

function parse(html) {
  if (!/Certified Provider/i.test(html) || !/Service Provider/i.test(html)) return { error: 'certified provider markers missing' };
  const table = html.match(/<table class="table-striped table category"[\s\S]*?<\/table>/i);
  if (!table) return { error: 'provider table missing' };
  const records = [];
  for (const tr of table[0].matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 3) continue;
    const name = textOf(cells[0]).replace(/\s+/g, ' ').trim();
    if (!name || /service provider/i.test(name)) continue;
    const blob = textOf(cells[1]);
    const phone = (blob.match(/Phone:\s*([^\n]+)/i) || [])[1] || '';
    const email = (blob.match(/Email:\s*(\S+)/i) || [])[1] || '';
    const address = blob.replace(/\n?Phone:[\s\S]*$/i, '').replace(/\s+/g, ' ').trim();
    records.push({
      name,
      address,
      phone: phone.replace(/\s+/g, ' ').trim(),
      email: email.trim(),
      contact_person: textOf(cells[2]).replace(/\s+/g, ' ').trim(),
    });
  }
  if (!records.length) return { error: 'provider table has no companies' };
  return { records };
}

export default async function lookup(keyword) {
  try {
    const q = String(keyword ?? '').trim();
    if (!q) return couldnt('other', 'empty keyword');
    if (!norm(q)) return couldnt('other', 'keyword has no distinctive name');
    let all = cache && Date.now() - cacheAt < 60000 ? cache : null;
    if (!all) {
      const res = await fetch(PAGE, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const text = await res.text();
      if (res.status === 401 || res.status === 403 || res.status === 429 || /just a moment|cf-browser-verification|captcha/i.test(text.slice(0, 500))) {
        return couldnt('blocked', 'HTTP ' + res.status);
      }
      if (!res.ok) return couldnt('http_error', 'HTTP ' + res.status);
      const parsed = parse(text);
      if (parsed.error) return couldnt('layout_changed', parsed.error);
      cache = parsed.records;
      cacheAt = Date.now();
      all = cache;
    }
    const hits = all.filter((row) => matches(q, row.name));
    if (!hits.length) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE, excerpt: 'No PTSP certified provider matched "' + q.slice(0, 140) + '" among ' + all.length + ' names.' };
    }
    return { status: 'found', reason: '', records: hits, source_url: PAGE, excerpt: [hits[0].name, hits[0].phone, hits[0].email, hits[0].contact_person].filter(Boolean).join(' | ').slice(0, 500) };
  } catch (err) {
    const reason = /timeout|aborted|ETIMEDOUT/i.test(String(err?.message || err)) ? 'timeout' : 'other';
    return couldnt(reason, err?.message || err);
  }
}
