export const meta = {
  task: 'JP-prtimes.jp',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'company_url', 'releases_on_first_page'],
  canary: { found: 'ダイゾーコンサルティング株式会社', not_found: '株式会社ゼズネクスストーリーダーイス' },
};

const SITE = 'https://prtimes.jp';
const SEARCH = `${SITE}/main/action.php?run=html&page=searchkey&search_word=`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words and marks, removed before two names are compared (Japanese and Latin forms).
const LEGAL = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|社団法人|財団法人|\(株\)|\(有\)|\(合\)|(?<![a-z])(?:co|corp|corporation|inc|incorporated|ltd|limited|llc|plc|gmbh|pte|sdn\s+bhd)(?![a-z])/gi;

function squash(s) {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Comparison key: the name without legal form, case, spaces and punctuation. */
function matchKey(s) {
  const nfkc = s.normalize('NFKC');
  return squash(nfkc.replace(LEGAL, ' ')) || squash(nfkc);
}

/** The name with the legal form taken out, used as a second, looser search. */
function coreQuery(s) {
  return s.normalize('NFKC').replace(LEGAL, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function plainText(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** One search request. Returns { fail } with a couldnt_check answer, or { url, total, shown, releases }. */
async function searchOnce(q) {
  const url = SEARCH + encodeURIComponent(q);
  const fail = (status, reason, excerpt) => ({ fail: { status, reason, records: [], source_url: url, excerpt } });

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', String(e?.message || e).slice(0, 200));
  }
  if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', `HTTP ${res.status}`);

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return fail('couldnt_check', 'other', String(e?.message || e).slice(0, 200));
  }
  if (/captcha|cf-chl|just a moment|challenge-platform/i.test(html)) return fail('couldnt_check', 'blocked', 'bot check page');

  // "検索結果：<span>N件" is the hit count; a miss shows "に合致するプレスリリースはありませんでした".
  const totalMatch = html.match(/検索結果：\s*<span[^>]*>\s*([\d,]+)/);
  const noHit = html.includes('に合致するプレスリリースはありませんでした');
  // A search with no hits comes back as HTTP 404 with the normal empty result page, so 404 counts as an answer
  // only when that page is there; any other non-200 is an error.
  if (!res.ok && !(res.status === 404 && (totalMatch || noHit))) return fail('couldnt_check', 'http_error', `HTTP ${res.status}`);
  if (!totalMatch && !noHit) return fail('couldnt_check', 'layout_changed', plainText(html).slice(0, 300));
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : 0;

  // Each release is an <article> card; its company link gives the company id and the name as the site writes it.
  const cards = html.split(/<article[\s>]/).slice(1).filter((c) => c.includes('/main/html/rd/p/'));
  const releases = [];
  for (const card of cards) {
    const m = card.match(/company_id\/(\d+)">([^<]*)<\/a>/);
    if (m) releases.push({ id: m[1], name: decode(m[2]).trim() });
  }
  if (total > 0 && cards.length === 0) return fail('couldnt_check', 'layout_changed', plainText(html).slice(0, 300));

  return { url, total, shown: cards.length, releases };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const target = matchKey(kw);
    if (!kw || !target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SITE, excerpt: 'empty or unusable company name' };
    }

    const queries = [kw];
    const core = coreQuery(kw);
    if (core && core !== kw) queries.push(core);

    let lastUrl = SEARCH + encodeURIComponent(kw);
    let allRead = true;
    const notes = [];

    for (const q of queries) {
      const r = await searchOnce(q);
      if (r.fail) return r.fail;
      lastUrl = r.url;

      const hits = new Map();
      for (const rel of r.releases) {
        if (matchKey(rel.name) !== target) continue;
        if (!hits.has(rel.id)) {
          hits.set(rel.id, {
            name: rel.name,
            company_id: rel.id,
            company_url: `${SITE}/main/html/searchrlp/company_id/${rel.id}`,
            releases_on_first_page: 0,
          });
        }
        hits.get(rel.id).releases_on_first_page++;
      }

      if (hits.size > 0) {
        const records = [...hits.values()];
        return {
          status: 'found',
          reason: '',
          records,
          source_url: r.url,
          excerpt: `${records.map((x) => x.name).join(' / ')}: ${r.total} releases match "${q}"`,
        };
      }

      if (r.total > r.shown) allRead = false;
      notes.push(`"${q}": ${r.total} releases, ${r.shown} read`);
    }

    if (allRead) {
      return { status: 'not_found', reason: '', records: [], source_url: lastUrl, excerpt: notes.join('; ') };
    }
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: lastUrl,
      excerpt: `No matching company in the first page of results (${notes.join('; ')}); the result list is longer than one page, so absence cannot be confirmed.`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: SITE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
