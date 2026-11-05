export const meta = {
  task: 'AU-ami.org.au',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'category', 'campaign', 'year'],
  canary: { found: 'LJ Hooker', not_found: 'Digital Next' },
};

const PAGE = 'https://ami.org.au/events/past-awards/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE, excerpt: String(excerpt || '').slice(0, 500) };
}

function decode(s) {
  return String(s || '')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ');
}

function plain(html) {
  return decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return plain(s).toUpperCase().replace(/&/g, ' ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function matches(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return false;
  if (q === n) return true;
  if (q.length < 6) return false;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?: |$)`).test(n);
}

export default async function lookup(keyword) {
  try {
    const q = String(keyword ?? '').trim();
    if (q.length < 3) return fail('other', 'company name too short');
    const res = await fetch(PAGE, {
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-AU,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const html = await res.text();
    const head = html.slice(0, 400).toLowerCase();
    if (res.status === 403 || res.status === 429 || head.includes('just a moment') || head.includes('cf-browser-verification')) {
      return fail('blocked', `HTTP ${res.status}`);
    }
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);
    const start = html.indexOf('Congratulations to all the national winners of the 2026');
    const end = html.indexOf('>PAST AWARDS<', start > 0 ? start : 0);
    if (start < 0 || end < 0 || !html.includes('CAMPAIGN CATEGORIES')) {
      return fail('layout_changed', plain(html).slice(0, 240));
    }
    const slice = html.slice(start, end);
    const items = slice.split('accr_item').slice(1);
    if (items.length < 15) return fail('layout_changed', `winner blocks ${items.length}`);
    const records = [];
    for (const item of items) {
      const cat = item.match(/<h5>([\s\S]*?)<\/h5>/);
      const paras = [...item.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => plain(m[1])).filter(Boolean);
      if (!paras.length) continue;
      const name = paras[0];
      const campaign = paras.slice(1).join(' ').replace(/^["“]|["”]$/g, '');
      if (matches(q, name)) {
        records.push({
          name,
          category: cat ? plain(cat[1]) : '',
          campaign,
          year: '2026',
        });
      }
    }
    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: 'Not named in the 2026 AMI Awards Winners block on the past-awards page.',
      };
    }
    const excerpt = records
      .map((r) => `${r.name} — ${r.category}${r.campaign ? ' — ' + r.campaign : ''}`)
      .join('; ')
      .slice(0, 500);
    return { status: 'found', reason: '', records, source_url: PAGE, excerpt };
  } catch (err) {
    const name = err && err.name;
    return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other', err && err.message);
  }
}
