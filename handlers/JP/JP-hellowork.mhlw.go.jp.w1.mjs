export const meta = {
  task: 'JP-hellowork.mhlw.go.jp',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'address', 'kyujin_no', 'job_title', 'listed_from', 'listed_until', 'open_listings',
    'employer_no', 'corporate_no', 'employees_total', 'established', 'capital', 'representative', 'industry',
    'base_pay', 'bonus', 'insurance'],
  canary: { found: '株式会社　心美', not_found: '架空ゼロヌル工房' },
};

// Hello Work Internet Service searches current general job listings (一般求人) by employer name (事業所名).
// Records are employers that have a listing; the site does not publish a list of all companies.
const BASE = 'https://www.hellowork.mhlw.go.jp/kensaku/GECA110010.do';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en;q=0.8',
};
const LEGAL_FORM = /株式会社|有限会社|合同会社|合資会社|合名会社|相互会社|一般社団法人|一般財団法人|社団法人|財団法人|特定非営利活動法人|\(株\)|\(有\)|\(合\)|\(同\)/g;
const DETAIL_LIMIT = 3;           // job detail pages read per lookup
const DETAIL_CUTOFF_MS = 40000;   // no new detail page after this
const BUDGET_MS = 55000;          // every fetch is cut off before the 60 s limit

const nfkc = (s) => String(s ?? '').normalize('NFKC');
/** Words of a company name with the legal form removed. The site separates words with ideographic spaces. */
function words(name) {
  return nfkc(name).replace(LEGAL_FORM, ' ').split(/[\s　]+/).filter(Boolean);
}
const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** The free-word search only accepts full-width ASCII. */
const fullWidth = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const plain = (html) => String(html ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#xa0;|　/gi, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const answer = (status, reason, records, source_url, excerpt) =>
  ({ status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) });
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

/** The site's employer name equals the searched name: its first words match, the rest are branch words. */
function sameCompany(siteName, kwWords) {
  const w = words(siteName);
  if (!kwWords.length || w.length < kwWords.length) return false;
  return key(w.slice(0, kwWords.length).join('')) === key(kwWords.join(''));
}

function parseCount(html) {
  const n = (html.match(/<span class="fb">([\d,]+)件<\/span>\s*中/) || [])[1];
  return n ? Number(n.replace(/,/g, '')) : null;
}

function parseListings(html) {
  return html.split('<tr class="kyujin_head">').slice(1).map((chunk) => {
    const link = chunk.match(/action=dispDetailBtn&amp;kJNo=(\d+)&amp;kJKbn=(\d+)&amp;jGSHNo=([^&"]+)&amp;fullPart=(\d+)/);
    if (!link) return null;
    const grab = (re) => plain(chunk.match(re)?.[1] ?? '');
    return {
      kjNo: link[1], kJKbn: link[2], jGSHNo: link[3], fullPart: link[4],
      name: grab(/事業所名<\/span>[\s\S]*?<div>([^<]*)<\/div>/),
      address: grab(/fa-map-marker[^>]*><\/i>\s*<div class="disp_inline_block">([^<]*)<\/div>/),
      title: grab(/職種<\/span>[\s\S]*?<div class="fb">([^<]*)<\/div>/),
      from: grab(/受付年月日<\/div>\s*<div>([^<]*)<\/div>/).replace(/^：/, ''),
      until: grab(/紹介期限日<\/div>\s*<div>([^<]*)<\/div>/).replace(/^：/, ''),
    };
  }).filter(Boolean);
}

function parseDetail(html) {
  const t = plain(html);
  if (!t.includes('事業所名')) return null;
  const pick = (re) => (t.match(re)?.[1] ?? '').trim();
  return {
    employer_no: pick(/事業所番号 ([\d-]+)/),
    corporate_no: pick(/法人番号 (\d{13})/),
    employees_total: pick(/従業員数 企業全体 ([\d,]+人)/),
    established: pick(/設立年 (\S+)/),
    capital: pick(/資本金 (\S+)/),
    representative: pick(/代表者名 ((?:(?!役職|代表者名).)+?) (?:法人番号|就業規則)/),
    industry: pick(/産業分類 (.+?) トライアル/),
    base_pay: pick(/基本給（月額平均）又は時間額 (.+?) 定額的に/),
    bonus: pick(/賞与制度の有無 (.+?) 労働時間/),
    insurance: pick(/加入保険等 (.+?) 退職金/),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const signal = () => AbortSignal.timeout(Math.max(1000, Math.min(25000, BUDGET_MS - (Date.now() - started))));
  let stage = 'start';
  try {
    const kw = words(keyword);
    if (!kw.length) return answer('couldnt_check', 'other', [], BASE, 'no company name in the keyword');
    // The site matches the employer name by part of a word. Use the longest word of the name.
    const term = fullWidth(kw.reduce((a, b) => (b.length > a.length ? b : a))).slice(0, 50);

    stage = 'session';
    const init = await fetch(`${BASE}?action=initDisp&screenId=GECA110010`, { headers: HEADERS, signal: signal() });
    const cookie = cookieOf(init);
    await init.text();
    if (init.status === 403 || init.status === 429) return answer('couldnt_check', 'blocked', [], BASE, `HTTP ${init.status}`);
    if (!init.ok) return answer('couldnt_check', 'http_error', [], BASE, `HTTP ${init.status}`);

    stage = 'search';
    const body = new URLSearchParams({
      screenId: 'GECA110010', action: 'searchBtn', kjKbnRadioBtn: '1',
      freeWordInput: term, freeWordRadioBtn: '0', freeCKBox: '2',
    });
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { ...HEADERS, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body, signal: signal(),
    });
    if (res.status === 403 || res.status === 429) return answer('couldnt_check', 'blocked', [], BASE, `HTTP ${res.status}`);
    if (!res.ok) return answer('couldnt_check', 'http_error', [], BASE, `HTTP ${res.status}`);
    const html = await res.text();
    if (/captcha/i.test(html)) return answer('couldnt_check', 'blocked', [], BASE, 'captcha page');
    if (html.includes('見つかりませんでした')) {
      return answer('not_found', '', [], BASE, `search "${term}": ご希望の条件に合致する情報は見つかりませんでした。`);
    }
    if (/入力エラー|システムエラー/.test(html)) {
      return answer('couldnt_check', 'other', [], BASE, `search "${term}" refused: ${html.includes('入力エラー') ? 'input error' : 'system error'}`);
    }

    const total = parseCount(html);
    const listings = parseListings(html);
    if (total === null && listings.length === 0) {
      return answer('couldnt_check', 'layout_changed', [], BASE, plain(html).slice(0, 300));
    }
    const shown = listings.length;
    const seen = total ?? shown;
    const hits = listings.filter((l) => sameCompany(l.name, kw));
    if (hits.length === 0) {
      if (seen > shown) {
        return answer('couldnt_check', 'other', [], BASE,
          `${seen} listings match "${term}" but only the first ${shown} were read; no exact name on that page`);
      }
      return answer('not_found', '', [], BASE, `search "${term}": ${shown} listing(s) read, none for "${kw.join(' ')}"`);
    }

    // One record per employer address; job detail pages are read for the first few only.
    stage = 'detail';
    const groups = new Map();
    for (const l of hits) {
      const k = `${l.name}|${l.address}`;
      if (!groups.has(k)) groups.set(k, { first: l, count: 0 });
      groups.get(k).count++;
    }
    const records = [];
    for (const { first, count } of [...groups.values()].slice(0, 10)) {
      const rec = {
        name: first.name, address: first.address, kyujin_no: first.kjNo, job_title: first.title,
        listed_from: first.from, listed_until: first.until, open_listings: count,
      };
      if (records.length < DETAIL_LIMIT && Date.now() - started < DETAIL_CUTOFF_MS) {
        try {
          const url = `${BASE}?screenId=GECA110010&action=dispDetailBtn&kJNo=${first.kjNo}&kJKbn=${first.kJKbn}` +
            `&jGSHNo=${first.jGSHNo}&fullPart=${first.fullPart}&iNFTeikyoRiyoDtiID=&kSNo=`;
          const d = await fetch(url, { headers: { ...HEADERS, Cookie: cookie }, signal: signal() });
          const dHtml = d.ok ? await d.text() : '';
          const detail = parseDetail(dHtml);
          if (detail) Object.assign(rec, detail);
          else rec.detail_note = `detail page not readable (HTTP ${d.status})`;
          rec.detail_url = url;
        } catch (e) {
          rec.detail_note = `detail page: ${e?.name || 'error'}`;
        }
      }
      records.push(rec);
    }
    const sourceUrl = records[0].detail_url || BASE;
    return answer('found', '', records, sourceUrl,
      `"${hits[0].name}" has ${hits.length} listing(s); ${seen} listing(s) matched "${term}" overall; first: ${hits[0].title}`);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return answer('couldnt_check', timeout ? 'timeout' : 'other', [], BASE,
      `${stage}: ${String(err?.message || err).slice(0, 200)}`);
  }
}
