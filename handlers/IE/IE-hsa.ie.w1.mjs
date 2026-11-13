export const meta = {
  task: 'IE-hsa.ie',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'year', 'court', 'case_text'],
  canary: { found: 'Felix O’Hare and Co Limited', not_found: 'Cuideachta Neamhchoitianta Teoranta' },
};

// HSA publishes prosecutions as plain year pages (2005-2019). The 2005 and 2006 cases are on two sub-pages each.
// Pages for 2020 onwards return 404 and are not published, so they are not checked.
const BASE = 'https://www.hsa.ie/eng/topics/inspections/prosecutions/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['limited', 'ltd', 'teoranta', 'teo', 'plc', 'dac', 'unlimited', 'uc', 'ulc']);
const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>' };
const FAIL_ORDER = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];

const PAGES = [];
for (const court of ['summarily', 'on_indictment']) {
  PAGES.push(`${BASE}prosecutions_2005/${court}/`, `${BASE}prosecutions_2006/${court}/`);
}
for (let y = 2007; y <= 2019; y++) PAGES.push(`${BASE}prosecutions_${y}/`);

/** Normalised company core: no case, no punctuation, '&' = 'and', no bracketed notes, no trailing legal form. */
function core(str) {
  const words = String(str || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Visible text of an HTML fragment, one line per block element. */
function toLines(fragment) {
  const text = decode(
    fragment
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?(p|li|tr|td|th|h[1-6]|div|br|ol|ul|table|section|dt|dd)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
  return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The main case area of a year page; null when the page has no such block (layout changed). */
function contentRegion(html) {
  const start = html.indexOf('<div class="content">');
  const end = html.indexOf('<div class="col-lg-3 column-lg left-panel">');
  if (start < 0 || end <= start) return null;
  return html.slice(start, end);
}

function courtFromUrl(url) {
  if (/summarily/.test(url)) return 'Summarily';
  if (/on_indictment/.test(url)) return 'On indictment';
  return '';
}

/** Lines on the page whose normalised name equals the keyword's (the name as a heading, list item or table cell). */
function matchLines(lines, kc, url) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const candidates = [raw, ...raw.split(/\s+t\/a\s+/i)];
    if (!candidates.some((c) => core(c) === kc)) continue;
    let court = courtFromUrl(url);
    let caseText = '';
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      if (/^(summarily|on indictment)$/i.test(lines[j])) court = lines[j].replace(/^on /i, 'On ').replace(/^summarily$/i, 'Summarily');
      if (!caseText && lines[j].length > 40 && /heard in|pleaded|convicted|found guilty|sentenced|fined/i.test(lines[j])) {
        caseText = lines[j].slice(0, 700);
      }
    }
    hits.push({ name: raw, court, caseText, year: (url.match(/prosecutions_(\d{4})/) || [])[1] || '', source_url: url });
  }
  // One record per name per page. Prefer the occurrence that carries the case text (the index list has none).
  const byName = new Map();
  for (const h of hits) {
    const list = byName.get(h.name) || [];
    list.push(h);
    byName.set(h.name, list);
  }
  const out = [];
  for (const list of byName.values()) {
    const withText = list.filter((h) => h.caseText);
    out.push(...(withText.length ? withText : [list[0]]));
  }
  return out;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { url, fail: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { url, fail: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    if (!/<title>[^<]*Health and Safety Authority/i.test(html)) {
      return { url, fail: 'layout_changed', detail: 'page is not the HSA prosecutions page' };
    }
    return { url, html };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { url, fail: timedOut ? 'timeout' : 'other', detail: String(err?.message || err).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const source = BASE;
  try {
    const kc = core(keyword);
    if (!kc) return { status: 'couldnt_check', reason: 'other', records: [], source_url: source, excerpt: 'empty company name' };

    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 50000); });
    const pages = await Promise.race([Promise.all(PAGES.map(fetchPage)), deadline]);
    clearTimeout(timer);
    if (pages === null) {
      return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: source, excerpt: 'the prosecution pages did not finish in 50 s' };
    }

    const records = [];
    const failures = [];
    for (const p of pages) {
      if (p.fail) { failures.push(p); continue; }
      const region = contentRegion(p.html);
      if (region === null) { failures.push({ url: p.url, fail: 'layout_changed', detail: 'no case block on the page' }); continue; }
      for (const h of matchLines(toLines(region), kc, p.url)) {
        records.push({ name: h.name, year: h.year, court: h.court, case_text: h.caseText, source_url: h.source_url });
      }
    }

    if (records.length > 0) {
      const first = records[0];
      return {
        status: 'found',
        reason: '',
        records,
        source_url: first.source_url,
        excerpt: `${records.length} HSA prosecution entr${records.length === 1 ? 'y' : 'ies'} matching "${keyword}": ${first.name} (${first.year}${first.court ? ', ' + first.court : ''})`,
      };
    }

    if (failures.length > 0) {
      const reason = FAIL_ORDER.find((r) => failures.some((f) => f.fail === r)) || 'other';
      const sample = failures.slice(0, 3).map((f) => `${f.url.replace(BASE, '')}: ${f.detail}`).join('; ');
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: failures[0].url,
        excerpt: `${failures.length} of ${PAGES.length} HSA prosecution pages could not be read, so absence cannot be proven. ${sample}`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: source,
      excerpt: `Checked all ${PAGES.length} HSA prosecution pages (2005-2019). No prosecution entry matches "${keyword}". The site publishes no prosecution pages for 2020 onwards.`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: source,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
