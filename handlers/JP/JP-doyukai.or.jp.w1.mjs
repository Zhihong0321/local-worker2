export const meta = {
  task: 'JP-doyukai.or.jp',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company', 'title', 'section', 'as_of'],
  canary: { found: '日本アイ・ビー・エム', not_found: '架空テスト商事株式会社' },
};

const PAGE = 'https://www.doyukai.or.jp/about/managers.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function clean(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare company names: NFKC, case, spaces and punctuation (incl. the ・ in アイ・ビー・エム) and legal form removed. */
function normalize(str) {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社団法人|財団法人|医療法人|学校法人|\(株\)|\(有\)|\bco\.?,?\s*ltd\.?|\bcorporation\b|\bcorp\.?|\bincorporated\b|\binc\.?|\blimited\b|\bltd\.?|\bk\.k\.?/g, '')
    .replace(/[\s　・･.,、()\[\]"'&/\-]/g, '');
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupPage(keyword);
  // Let the socket close before the runner calls process.exit: on Windows, Node 24 aborts (exit 127) if exit follows a fetch at once.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return answer;
}

async function lookupPage(keyword) {
  try {
    const name = String(keyword || '').trim();
    if (!name) return fail('other', PAGE, 'empty company name');
    // The site lists its officers in Japanese only, so a Latin-only name cannot be matched here.
    if (!/[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(name)) {
      return fail('other', PAGE, 'name has no Japanese characters; the officer list is published in Japanese only');
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', PAGE, `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', PAGE, `HTTP ${res.status}`);

    const html = await res.text();
    if (!html.includes('役員紹介') || !html.includes('managers-list__item__right')) {
      return fail('layout_changed', PAGE, html.slice(0, 300));
    }

    const asOfMatch = html.match(/(\d{4}年\d{1,2}月\d{1,2}日現在)/);
    const asOf = asOfMatch ? asOfMatch[1] : '';

    // Each officer is one <p class="managers-list__item__right">: <strong>name</strong><br>company<br><span>title</span>
    const officers = [];
    const itemRe = /<p class="managers-list__item__right">([\s\S]*?)<\/p>/g;
    let m;
    while ((m = itemRe.exec(html)) !== null) {
      const inner = m[1];
      const nameHtml = inner.match(/<strong>([\s\S]*?)<\/strong>/);
      const rest = inner.replace(/<strong>[\s\S]*?<\/strong>/, '');
      const parts = rest.split(/<br\s*\/?>/i).map(clean).filter(Boolean);
      const headings = html.slice(0, m.index).match(/<h[23][^>]*>[\s\S]*?<\/h[23]>/g) || [];
      officers.push({
        name: clean(nameHtml ? nameHtml[1] : ''),
        company: parts[0] || '',
        title: parts.slice(1).join(' '),
        section: headings.length ? clean(headings[headings.length - 1]) : '',
        as_of: asOf,
      });
    }
    if (officers.length === 0) return fail('layout_changed', PAGE, 'no officer entries found');

    const kw = normalize(name);
    const records = officers.filter((o) => o.company && normalize(o.company) === kw);

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `No officer of the Doyukai board (${asOf || 'current list'}) is listed with company "${name}"`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE,
      excerpt: records.map((r) => `${r.name} / ${r.company} / ${r.title} (${r.section})`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', PAGE, String((err && err.message) || err));
  }
}
