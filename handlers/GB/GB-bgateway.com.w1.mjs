export const meta = {
  task: 'GB-bgateway.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'matched_title', 'category', 'date', 'url', 'excerpt'],
  canary: { found: 'Siar Interactive', not_found: 'Zorvantek Lochside Ltd' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.bgateway.com';
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'co', 'company', 'corp', 'corporation',
  'sdn', 'bhd', 'gmbh', 'sa', 'ag', 'bv', 'pty', 'cic', 'lp', 'sl', 'srl', 'spa']);

function words(str) {
  return (str || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** Core name: normalised words with trailing legal-form words removed. */
function coreName(str) {
  const w = words(str);
  while (w.length && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
  return w;
}

function cleanText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2013;|&ndash;/gi, '-')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&#34;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchOpts() {
  return { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: AbortSignal.timeout(25000) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await check(keyword);
  // Let the sockets of the last fetch close before the worker's runner exits (Windows Node aborts otherwise).
  await new Promise((done) => setTimeout(done, 500));
  return answer;
}

async function check(keyword) {
  // The site search needs every typed word to appear, so the legal form ("Ltd") is left out of the query.
  const core = coreName(keyword);
  const searchUrl = `${BASE}/search?query=${encodeURIComponent(core.join(' '))}&pageSize=36`;
  try {
    if (core.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'name has no words left after removing the legal form' };
    }

    // Step 1: site search (GET). Results are the site's own articles (case studies, events, resources, news).
    const res = await fetch(searchUrl, fetchOpts());
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (/captcha|cf-chl|are you a robot/i.test(html.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'bot check page' };
    }
    const countMatch = html.match(/There\s+are\s+(\d+)\s+results?\s+for/i);
    if (!countMatch || !/data-search-results/.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    const total = parseInt(countMatch[1], 10);
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `There are 0 results for ${core.join(' ')}` };
    }

    // Result cards: type label, link, title.
    const cards = [...html.matchAll(/<article class="card card--result">([\s\S]*?)<\/article>/g)].map((m) => {
      const link = m[1].match(/<a href="([^"]+)"[^>]*class="card__link"[^>]*>([\s\S]*?)<\/a>/);
      const label = m[1].match(/text-uppercase">([\s\S]*?)<\/span>/);
      return link ? { url: new URL(link[1], BASE).href, title: cleanText(link[2]), category: label ? cleanText(label[1]) : '' } : null;
    }).filter(Boolean);

    if (cards.length === 0 || cards.length < Math.min(total, 36)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: `${total} results but ${cards.length} result cards parsed` };
    }

    // Step 2: open each result and check the company name really appears in its text (whole words, legal form ignored).
    const pages = await Promise.all(cards.map(async (card) => {
      try {
        const r = await fetch(card.url, fetchOpts());
        if (!r.ok) return { card, error: `HTTP ${r.status}` };
        const main = (await r.text()).match(/<main[\s\S]*?<\/main>/i)?.[0] || '';
        return { card, text: cleanText(main) };
      } catch (e) {
        return { card, error: String(e?.message || e).slice(0, 120) };
      }
    }));

    const records = [];
    const errors = [];
    const needle = ` ${core.join(' ')} `;
    for (const p of pages) {
      if (p.error) { errors.push(`${p.card.url} ${p.error}`); continue; }
      const hay = ` ${words(p.text).join(' ')} `;
      const at = hay.indexOf(needle);
      if (at === -1) continue;
      // Excerpt: the sentence-ish window around the match in the original text.
      const pos = p.text.toLowerCase().search(new RegExp(core.map((w) => w.replace(/[^a-z0-9]/g, '')).join('[^a-z0-9]+')));
      const from = Math.max(0, pos - 150);
      records.push({
        name: keyword,
        matched_title: p.card.title,
        category: p.card.category,
        date: (p.text.match(/Posted (\d{1,2} [A-Za-z]+ \d{4})/) || [])[1] || '',
        url: p.card.url,
        excerpt: p.text.slice(from, pos + 250).trim(),
      });
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: searchUrl,
        excerpt: `${records.length} page(s) on bgateway.com name "${keyword}" (${total} search results)` };
    }

    // Some pages could not be opened, so a miss is not proof of absence.
    if (errors.length > 0) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl,
        excerpt: `${errors.length} result page(s) could not be read: ${errors.slice(0, 3).join('; ')}` };
    }
    // More results than we checked: a miss is not proof of absence.
    if (total > cards.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl,
        excerpt: `${total} results, only the first ${cards.length} checked` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
      excerpt: `${total} search result(s) for ${keyword}, none names the company` };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
