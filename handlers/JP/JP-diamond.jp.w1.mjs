export const meta = {
  task: 'JP-diamond.jp',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_page'],
  canary: { found: '竹中工務店', not_found: '架空商事株式会社' },
};

const LIST_URL = 'https://diamond.jp/list/companies';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words are dropped on both sides before comparing, so "株式会社竹中工務店" = "竹中工務店".
const LEGAL_FORM = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|\(株\)|\(有\)|\(同\)/g;

function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .replace(LEGAL_FORM, '')
    .replace(/[\s　.,・･\-‐－()（）]/g, '')
    .toLowerCase();
}

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = normalize(keyword);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name' };
    }

    const res = await fetch(LIST_URL, {
      headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|アクセスが集中|Access Denied/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: 'bot or access check page' };
    }

    // The company index: <a class="company" href="/list/companies/<id>">NAME</a>
    const entries = [];
    const re = /<a class="company" href="\/list\/companies\/(\d+)">([^<]*)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      entries.push({ id: m[1], name: decodeEntities(m[2]) });
    }
    if (entries.length === 0 || !html.includes('企業一覧')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: html.slice(0, 300) };
    }

    const matches = entries.filter((e) => normalize(e.name) === target);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No match in the company index (${entries.length} companies) for ${keyword}`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((e) => ({
        name: e.name,
        company_page: `https://diamond.jp/list/companies/${e.id}`,
      })),
      source_url: LIST_URL,
      excerpt: matches.map((e) => `${e.name} — https://diamond.jp/list/companies/${e.id}`).join('\n').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: LIST_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
