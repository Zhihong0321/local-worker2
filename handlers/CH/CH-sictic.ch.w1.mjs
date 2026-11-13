export const meta = { task: 'CH-sictic.ch', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'list', 'description', 'website', 'exit_note', 'source_url'],
  canary: { found: 'Acodis AG', not_found: 'Schweizerische Alpkäserei Bergblüte GmbH' } };

// Two plain public lists on sictic.ch, each one page with every entry in it (no pagination):
//  - the startup portfolio (companies that received funding from SICTIC investors)
//  - the startups that pitched at Swiss ICT Investor Day events
const PAGES = [
  { url: 'https://www.sictic.ch/sictic-portfolio/', list: 'SICTIC startup portfolio (funded by SICTIC investors)' },
  { url: 'https://www.sictic.ch/sictic-startups/', list: 'SICTIC startups (pitched at Swiss ICT Investor Day)' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words dropped from the end of a name before comparing ("Acodis AG" == "Acodis").
const LEGAL = new Set(['ag', 'sa', 'gmbh', 'sarl', 'sagl', 'srl', 'ltd', 'limited', 'inc', 'llc', 'corp', 'co', 'kg',
  'ug', 'sas', 'spa', 'bv', 'plc', 'ab', 'oy', 'as', 'lda', 'slu']);

function normalizeName(s) {
  const words = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#8217;|&rsquo;/g, "'").replace(/&#8211;|&ndash;/g, '-').replace(/&quot;|&#039;|&#39;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Each list entry sits in <div class="content-wrapper"><h3><a …>NAME</a></h3> … <p>description</p> … </div>. */
function parseEntries(html) {
  const entries = [];
  const chunks = html.split('<div class="content-wrapper">').slice(1);
  for (const chunk of chunks) {
    const body = chunk.split('</article>')[0];
    const h3 = body.match(/^\s*<h3>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const name = cleanText(h3[1]);
    if (!name) continue;
    const href = h3[1].match(/href="([^"]+)"/);
    const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => cleanText(m[1])).filter(Boolean);
    const description = paragraphs.find((p) => !/^Exit in \d{4}$/i.test(p)) || '';
    const exit = paragraphs.find((p) => /^Exit in \d{4}$/i.test(p)) || '';
    entries.push({ name, key: normalizeName(name), website: href ? href[1] : '', description, exit_note: exit });
  }
  return entries;
}

function failure(page, reason, excerpt) {
  return { page, failed: true, reason, excerpt };
}

async function loadList(page) {
  try {
    const res = await fetch(page.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return failure(page, 'blocked', `HTTP ${res.status}`);
    if (!res.ok) return failure(page, 'http_error', `HTTP ${res.status}`);
    const html = await res.text();
    const entries = parseEntries(html);
    if (entries.length === 0 && /captcha|cf-chl|challenge-platform|access denied/i.test(html)) {
      return failure(page, 'blocked', 'bot check page');
    }
    if (entries.length < 20) {
      return failure(page, 'layout_changed', `only ${entries.length} list entries found; ${html.slice(0, 200)}`);
    }
    return { page, entries };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(page, timedOut ? 'timeout' : 'other', String(err?.message || err).slice(0, 300));
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normalizeName(keyword);
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGES[0].url, excerpt: 'empty company name' };
    }

    const loaded = await Promise.all(PAGES.map(loadList));
    const records = [];
    let firstMatchUrl = '';
    for (const r of loaded) {
      if (r.failed) continue;
      for (const e of r.entries) {
        if (e.key !== want) continue;
        if (!firstMatchUrl) firstMatchUrl = r.page.url;
        records.push({
          name: e.name,
          list: r.page.list,
          description: e.description,
          website: e.website,
          exit_note: e.exit_note,
          source_url: r.page.url,
        });
      }
    }

    if (records.length > 0) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstMatchUrl,
        excerpt: records.map((x) => `${x.name} (${x.list})${x.description ? ': ' + x.description : ''}`).join(' | ').slice(0, 500),
      };
    }

    // No match. Only a clean answer from every list counts as not_found: a list that refused or failed is never "not listed".
    const failed = loaded.find((r) => r.failed);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.page.url, excerpt: failed.excerpt };
    }
    const counts = loaded.map((r) => `${r.entries.length} on ${r.page.url}`).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGES[0].url,
      excerpt: `No entry matching "${String(keyword).trim()}" (${counts})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: PAGES[0].url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
