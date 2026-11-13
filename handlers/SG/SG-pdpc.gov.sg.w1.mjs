export const meta = {
  task: 'SG-pdpc.gov.sg',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'decision', 'decision_type', 'published', 'url'],
  canary: { found: 'Cortina Watch', not_found: '新加坡虚构数据保护测试有限公司' },
};

// The enforcement decisions page is server-rendered: its full list (title + address of every decision) is in the page.
const LISTING = 'https://www.pdpc.gov.sg/organisations/regulations-decisions/enforcement-decisions';
const ORIGIN = 'https://www.pdpc.gov.sg';
const ENF_PATH = '/organisations/regulations-decisions/enforcement-decisions/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-SG,en;q=0.9',
};
const LEGAL_WORDS = new Set(['pte', 'ltd', 'limited', 'private', 'llp', 'llc', 'inc', 'incorporated', 'sdn', 'bhd']);
const LEGAL_CJK = /私人有限责任公司|私人有限公司|有限责任公司|股份有限公司|有限公司/g;

/** Normalised company key: lower case, punctuation and legal-form words removed. */
function nameKey(s) {
  const base = String(s || '').replace(LEGAL_CJK, '').toLowerCase();
  return base.split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL_WORDS.has(t)).join('');
}

/** "Breach of the Protection Obligation by Cortina Watch" -> title, party and the party names inside it. */
function splitLabel(label) {
  const m = label.match(/^(.*?)\s+by\s+(.+)$/i);
  const title = m ? m[1].trim() : '';
  const party = (m ? m[2] : label).trim();
  const parts = party.split(/\s+(?:and|&)\s+|\s*,\s*/i).map((s) => s.trim()).filter(Boolean);
  return { title, party, candidates: [party, ...parts] };
}

/** Reads every enforcement-decision entry ({label, url}) from the listing page's embedded data. */
function parseListing(html) {
  const seen = new Map();
  const re = /\\"label\\":\\"(.{1,400}?)\\",\\"url\\":\\"([^"\\]{1,300})\\"/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[2];
    if (!url.startsWith(ENF_PATH) || seen.has(url)) continue;
    let label = m[1];
    try { label = JSON.parse('"' + m[1] + '"'); } catch { /* keep the raw text */ }
    seen.set(url, label.trim());
  }
  return [...seen].map(([url, label]) => ({ url, label }));
}

/** "Published on 23 May 2024" from a decision page. */
function parsePublished(html) {
  const i = html.indexOf('Published on');
  if (i < 0) return '';
  const d = html.slice(i, i + 300).match(/\d{1,2} [A-Za-z]+ \d{4}/);
  return d ? d[0] : '';
}

function netFail(err, url) {
  const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: url,
    excerpt: String((err && err.message) || err).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const kwKey = nameKey(kw);
    if (!kwKey) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LISTING,
        excerpt: 'the keyword has no company name in it' };
    }

    let res;
    try {
      res = await fetch(LISTING, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    } catch (err) {
      return netFail(err, LISTING);
    }
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LISTING, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LISTING, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const entries = parseListing(html);
    if (entries.length === 0) {
      if (/captcha|cf-chl|access denied|are you a robot/i.test(html)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LISTING, excerpt: 'bot or captcha page' };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LISTING, excerpt: html.slice(0, 300) };
    }

    const hits = [];
    for (const e of entries) {
      const p = splitLabel(e.label);
      if (p.candidates.map(nameKey).includes(kwKey)) hits.push({ ...e, ...p });
    }
    if (hits.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: LISTING,
        excerpt: `${entries.length} PDPC enforcement decisions listed; none names "${kw}"` };
    }

    // One detail page per match, for the published date. A failed detail read keeps the record with an empty date.
    const records = await Promise.all(hits.map(async (h) => {
      const url = new URL(h.url, ORIGIN).href;
      let published = '';
      try {
        const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
        if (r.ok) published = parsePublished(await r.text());
      } catch { /* keep the listing data */ }
      return { name: h.party, decision: h.label, decision_type: h.title, published, url };
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records.length === 1 ? records[0].url : LISTING,
      excerpt: records.map((r) => r.decision).join('; ').slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: LISTING,
      excerpt: String((err && err.message) || err).slice(0, 300) };
  }
}
