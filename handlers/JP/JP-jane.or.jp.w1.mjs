export const meta = {
  task: 'JP-jane.or.jp',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'membership', 'section', 'website'],
  canary: { found: '楽天グループ株式会社', not_found: '株式会社架空テスト商事' },
};

// JANE publishes its member companies as plain HTML lists (no search, no login):
//   /member/ippan/  = 一般会員企業一覧 (sections 上場企業 / 非上場企業)
//   /member/sanjo/  = 賛助会員企業一覧
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LISTS = [
  { url: 'https://jane.or.jp/member/ippan/', membership: '一般会員' },
  { url: 'https://jane.or.jp/member/sanjo/', membership: '賛助会員' },
];

// Legal-form words/marks removed before comparing names. Japanese forms are removed anywhere in the name.
const LEGAL_JA = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人/g;
const LEGAL_EN = /\b(incorporated|inc|corporation|corp|limited|ltd|llc)\b\.?|\bco\.?\s*,?\s*ltd\.?/g;

/** Compare-key: NFKC, lower case, legal form removed, only letters and digits kept. */
function normalize(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(株\)|\(有\)|\(同\)/g, '')
    .replace(LEGAL_JA, '')
    .replace(LEGAL_EN, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Read the company entries of one list page. Returns null when the page does not have the expected shape. */
function parseList(html, membership, url) {
  const entries = [];
  let lists = 0;
  let section = '';
  const blockRe = /class="section_title">([^<]*)|<ul class="link_list"[^>]*>([\s\S]*?)<\/ul>/g;
  let block;
  while ((block = blockRe.exec(html))) {
    if (block[1] !== undefined) {
      section = cleanText(block[1]);
      continue;
    }
    lists++;
    // Items are either linked (<li><a href="site">Name</a></li>) or plain text (<li>Name</li>).
    const itemRe = /<li>(?:<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|([^<]*))<\/li>/g;
    let item;
    while ((item = itemRe.exec(block[2]))) {
      const name = cleanText(item[2] !== undefined ? item[2] : item[3]);
      if (!name) continue;
      entries.push({
        name,
        membership,
        section,
        website: item[1] ? decodeEntities(item[1]) : '',
        list_url: url,
      });
    }
  }
  if (lists === 0 || entries.length === 0) return null;
  return entries;
}

/** Fetch and parse one list. Never throws; returns { ok: true, entries } or { ok: false, reason, url, excerpt }. */
async function fetchList(list) {
  try {
    const res = await fetch(list.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.5',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: 'blocked', url: list.url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', url: list.url, excerpt: `HTTP ${res.status}` };
    }
    if (String(res.url).includes('/members-portal/')) {
      return { ok: false, reason: 'blocked', url: list.url, excerpt: `redirected to login: ${res.url}` };
    }
    const html = await res.text();
    const entries = parseList(html, list.membership, list.url);
    if (entries) return { ok: true, entries, url: list.url };
    if (/challenge-platform|cf-chl|captcha/i.test(html)) {
      return { ok: false, reason: 'blocked', url: list.url, excerpt: 'bot check page' };
    }
    return { ok: false, reason: 'layout_changed', url: list.url, excerpt: cleanText(html).slice(0, 300) };
  } catch (err) {
    return {
      ok: false,
      reason: isTimeout(err) ? 'timeout' : 'other',
      url: list.url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kwNorm = normalize(keyword);
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LISTS[0].url, excerpt: 'empty company name' };
    }

    const results = await Promise.all(LISTS.map(fetchList));
    const entries = results.filter((r) => r.ok).flatMap((r) => r.entries);
    const matches = entries.filter((e) => normalize(e.name) === kwNorm);

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((e) => ({
          name: e.name,
          membership: e.membership,
          section: e.section,
          website: e.website,
        })),
        source_url: matches[0].list_url,
        excerpt: matches.map((e) => `${e.name} | ${e.membership}${e.section ? ' | ' + e.section : ''}`).join(' ; ').slice(0, 500),
      };
    }

    // Absence can only be claimed when every list was read.
    const failed = results.find((r) => !r.ok);
    if (failed) {
      return { status: 'couldnt_check', reason: failed.reason, records: [], source_url: failed.url, excerpt: failed.excerpt };
    }

    const counts = results.map((r) => `${r.entries.length} entries on ${r.url}`).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: LISTS[0].url,
      excerpt: `Not in the member lists (${counts})`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: LISTS[0].url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
