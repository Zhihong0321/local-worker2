export const meta = {
  task: 'AU-accc.gov.au',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'kind', 'date', 'url'],
  canary: { found: 'Digital Imaging Express Pty Ltd', not_found: 'Chromatix' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fail(reason, excerpt, source_url) {
  return { status: 'couldnt_check', reason, records: [], source_url: source_url || '', excerpt: String(excerpt || '').slice(0, 500) };
}

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ');
}

function textOf(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function kindFrom(path) {
  if (path.includes('/infringement-notices-register/')) return 'infringement notice';
  if (path.includes('/undertakings-registers/')) return 'undertaking';
  if (path.includes('/public-warning-notice-register/')) return 'public warning notice';
  const m = path.match(/\/public-registers\/([^/]+)/);
  return m ? m[1].replace(/-/g, ' ') : 'public register';
}

function parseCards(html) {
  const records = [];
  const parts = html.split('<article ');
  for (const part of parts.slice(1)) {
    const chunk = part.slice(0, 8000);
    const link = chunk.match(/<a href="(\/public-registers\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const name = textOf(link[2]);
    if (!name) continue;
    const body = chunk.match(/accc-card__text[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
    const time = chunk.match(/<time[^>]*>([^<]*)<\/time>/);
    records.push({
      name,
      kind: kindFrom(link[1]),
      date: time ? textOf(time[1]) : '',
      url: 'https://www.accc.gov.au' + link[1],
      summary: body ? textOf(body[1]).slice(0, 280) : '',
    });
  }
  return records;
}

export default async function lookup(keyword) {
  const q = String(keyword ?? '').trim();
  if (q.length < 3) return fail('other', 'company name too short');
  const phrase = q.replace(/"/g, '');
  const source_url =
    'https://www.accc.gov.au/public-registers/browse-public-registers?query=' +
    encodeURIComponent('"' + phrase + '"') +
    '&sort_by=search_api_relevance';
  try {
    const res = await fetch(source_url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html',
        'accept-language': 'en-AU,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const html = await res.text();
    const head = html.slice(0, 500).toLowerCase();
    if (res.status === 403 || res.status === 429 || head.includes('access denied') || head.includes('just a moment')) {
      return fail('blocked', `HTTP ${res.status} ${textOf(html).slice(0, 200)}`, source_url);
    }
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`, source_url);
    const hasView = html.includes('view-id-acccgov_public_registers');
    const perf = html.match(/accc-search-performance">([^<]+)/);
    const empty = html.includes('No public registers found.');
    if (!hasView || (!perf && !empty)) return fail('layout_changed', textOf(html).slice(0, 240), source_url);

    const records = parseCards(html).map(({ summary, ...row }) => row);
    if (records.length === 0) {
      if (!empty) return fail('layout_changed', 'search view had no cards and no empty marker', source_url);
      return { status: 'not_found', reason: '', records: [], source_url, excerpt: 'No public registers found.' };
    }
    const excerpt = records
      .slice(0, 4)
      .map((r) => `${r.name} (${r.kind}${r.date ? ', ' + r.date : ''})`)
      .join('; ')
      .slice(0, 500);
    return { status: 'found', reason: '', records, source_url, excerpt };
  } catch (err) {
    const name = err && err.name;
    return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other', err && err.message, source_url);
  }
}
