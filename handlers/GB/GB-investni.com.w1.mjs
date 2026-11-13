export const meta = { task: 'GB-investni.com', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'directory', 'sectors', 'website', 'page_url'],
  canary: { found: 'Acksen Ltd', not_found: 'Zyxwvu Nonexistent Holdings Ltd' } };

// Invest NI publishes three supplier directories (company lists, 25 per page). A name is "found" only if it is in one of them.
const BASE = 'https://www.investni.com/international-business/';
const DIRECTORIES = [
  { slug: 'energy-and-water-supply-chain-company-directory', label: 'Energy and water supply chain company directory' },
  { slug: 'materials-handling-company-directory', label: 'Materials handling company directory' },
  { slug: 'smart-cities-companies-directory', label: 'Smart Cities company directory' },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'lp', 'llc']);

class Check extends Error {
  constructor(reason, url, message) { super(message); this.reason = reason; this.url = url; }
}

function clean(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Same company = same letters and digits, legal form dropped at the end ("ACKSEN LIMITED" = "Acksen Ltd"). */
function normalize(s) {
  const toks = clean(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (toks.length > 1 && LEGAL_FORMS.has(toks[toks.length - 1])) toks.pop();
  return toks.join('');
}

async function getHtml(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Check('timeout', url, 'no answer within 25 s');
    throw new Check('other', url, String(e?.message || e).slice(0, 200));
  }
  if (res.status === 403 || res.status === 429) throw new Check('blocked', url, `HTTP ${res.status}`);
  if (!res.ok) throw new Check('http_error', url, `HTTP ${res.status}`);
  let html;
  try {
    html = await res.text();
  } catch (e) {
    throw new Check(e?.name === 'TimeoutError' ? 'timeout' : 'other', url, String(e?.message || e).slice(0, 200));
  }
  if (/<title>[^<]*(Just a moment|Access denied|Attention Required)/i.test(html) || html.includes('cf-chl')) {
    throw new Check('blocked', url, 'bot check page');
  }
  return html;
}

/** One record per company card on a directory page. */
function parseEntries(html, pageUrl) {
  return html.split(/<li class="entry/).slice(1).map((chunk) => {
    const head = chunk.split(/col-md-8 links/)[0];
    const nameMatch = head.match(/details col-md-16 no-padding">\s*(?:<h3>\s*)+([^<]*?)\s*<\/h3>/);
    if (!nameMatch) return null;
    const sectors = [...head.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => clean(m[1])).filter(Boolean);
    const web = chunk.match(/class="link link-web"[\s\S]*?href="([^"]+)"/);
    return { name: clean(nameMatch[1]), sectors, website: web ? web[1] : '', page_url: pageUrl };
  }).filter(Boolean);
}

/** Reads every page of one directory. Any page that cannot be read makes the whole directory unreadable. */
async function readDirectory(d) {
  const base = BASE + d.slug;
  const firstHtml = await getHtml(base);
  if (!firstHtml.includes('view-company-directory')) throw new Check('layout_changed', base, 'directory page has no company list');
  const firstEntries = parseEntries(firstHtml, base);
  if (firstEntries.length === 0) throw new Check('layout_changed', base, 'no company entries on the first page');

  const text = firstHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const pager = text.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
  const total = pager ? Number(pager[3]) : firstEntries.length;
  const pageCount = Math.ceil(total / firstEntries.length);

  const urls = [];
  for (let i = 1; i < pageCount; i++) urls.push(`${base}?page=%2C${i}`);
  const restHtml = await Promise.all(urls.map((u) => getHtml(u)));
  let entries = firstEntries;
  restHtml.forEach((html, i) => { entries = entries.concat(parseEntries(html, urls[i])); });

  if (entries.length !== total) {
    throw new Check('layout_changed', base, `read ${entries.length} companies, the page says ${total}`);
  }
  return { base, label: d.label, entries };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = normalize(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name' };
    }

    const directories = await Promise.all(DIRECTORIES.map((d) => readDirectory(d)));

    const records = [];
    for (const dir of directories) {
      for (const e of dir.entries) {
        if (normalize(e.name) === kw) {
          records.push({ name: e.name, directory: dir.label, sectors: e.sectors, website: e.website, page_url: e.page_url });
        }
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].page_url,
        excerpt: `${records[0].name} is listed in: ${[...new Set(records.map((r) => r.directory))].join('; ')}`,
      };
    }

    const checked = directories.reduce((n, dir) => n + dir.entries.length, 0);
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: directories.map((dir) => dir.base).join(' '),
      excerpt: `not in the ${directories.length} supplier directories (${checked} companies read)`,
    };
  } catch (err) {
    if (err instanceof Check) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: err.url, excerpt: err.message.slice(0, 300) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: String(err?.message || err).slice(0, 300) };
  }
}
