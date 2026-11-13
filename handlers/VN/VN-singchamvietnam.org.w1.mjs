export const meta = {
  task: 'VN-singchamvietnam.org',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'address', 'phone', 'email', 'website'],
  canary: { found: 'ACEN VIETNAM JOINT STOCK COMPANY', not_found: 'Công ty Cổ phần Thương mại Dịch vụ Hoàng Long Phúc Thịnh' },
};

// The SingCham membership directory (/company-list/) searches through WordPress admin-ajax.php,
// action=filter_members, POST. The search is a plain substring match on the member name (accent-insensitive).
const AJAX = 'https://singchamvn.org/wp-admin/admin-ajax.php';
const PAGE = 'https://singchamvn.org/company-list/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 40;
const DEADLINE_MS = 45000;

// Legal-form words and phrases, removed on both sides before comparing names.
const LEGAL_PHRASES = ['cong ty', 'co phan', 'trach nhiem huu han', 'mot thanh vien'];
const LEGAL_WORDS = new Set(['co', 'ltd', 'limited', 'llc', 'jsc', 'joint', 'stock', 'company', 'corporation', 'corp',
  'pte', 'pvt', 'sdn', 'bhd', 'tnhh', 'mtv', 'llp', 'lp', 'inc', 'plc', 'liability', 'law']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(NAMED, n.toLowerCase()) ? NAMED[n.toLowerCase()] : m));
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised name for comparison: case, accents, punctuation, and legal form removed. */
function normalize(s) {
  let t = decodeEntities(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  t = ' ' + t + ' ';
  for (const p of LEGAL_PHRASES) {
    while (t.includes(' ' + p + ' ')) t = t.replace(' ' + p + ' ', ' ');
  }
  return t.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

/** Parse the member cards in one results fragment. */
function parseCards(html, previousHtml) {
  const parts = String(html || '').split(/(?=<h4[^>]*elementor-heading-title)/i);
  const cards = [];
  for (let i = 0; i < parts.length; i++) {
    const h = parts[i].match(/^<h4[^>]*>([\s\S]*?)<\/h4>/i);
    if (!h) continue;
    const name = cleanText(h[1]);
    // The category label sits in the markup just before the name, so take the last one before this heading.
    const before = i > 0 ? parts[i - 1] : (previousHtml || '');
    const cats = [...before.matchAll(/elementor-post-info__terms-list-item[^>]*>([\s\S]*?)<\/span>/gi)];
    const category = cats.length ? cleanText(cats[cats.length - 1][1]) : '';
    const body = parts[i];
    const addr = body.match(/<span>\s*Address:\s*<\/span>\s*<span class="black">([\s\S]*?)<\/span>\s*<\/div>/i);
    const tel = body.match(/<span>\s*Tel:\s*<\/span>\s*<span class="black">([\s\S]*?)<\/span>/i);
    const email = body.match(/Email:\s*<span class="black">([\s\S]*?)<\/span>/i);
    const web = body.match(/Website:\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    cards.push({
      name,
      text: cleanText(body).slice(0, 300),
      record: {
        name,
        category,
        address: addr ? cleanText(addr[1]) : '',
        phone: tel ? cleanText(tel[1]) : '',
        email: email ? cleanText(email[1]) : '',
        website: web ? cleanText(web[1]) : '',
      },
    });
  }
  return cards;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Let the sockets of the last POST settle before the runner exits (a Windows Node race otherwise aborts the process).
  await new Promise((resolve) => setTimeout(resolve, 200));
  return answer;
}

async function lookupOnce(keyword) {
  const started = Date.now();
  try {
    const input = String(keyword || '').trim();
    const target = normalize(input);
    if (!target) return couldnt('other', PAGE, 'no company name in the input');

    // The site matches the typed text as a substring, so search by the first word of the name
    // (legal form dropped). Very short first words would match too much, so those scan the whole list.
    const first = target.split(' ')[0];
    const search = first.length >= 3 ? first : '';

    let page = 1;
    let maxPages = 1;
    let entries = 0;
    let previousHtml = '';
    const matches = [];
    const seen = new Set();
    let firstText = '';

    while (page <= maxPages) {
      if (Date.now() - started > DEADLINE_MS) return couldnt('timeout', PAGE, 'the directory search did not finish in time');

      const body = new URLSearchParams({ action: 'filter_members', search, category: '', sort: 'asc', tag: '', page: String(page) });
      const res = await fetch(AJAX, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': PAGE,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(25000),
      });
      const text = await res.text();

      if (res.status === 403 || res.status === 429) return couldnt('blocked', PAGE, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', PAGE, `HTTP ${res.status}`);
      if (/captcha|challenge-platform|cf-chl/i.test(text)) return couldnt('blocked', PAGE, 'bot check page');

      let j;
      try { j = JSON.parse(text); } catch (e) { return couldnt('layout_changed', PAGE, text.slice(0, 200)); }
      if (!j || j.success !== true || !j.data || typeof j.data.html !== 'string') {
        return couldnt('layout_changed', PAGE, JSON.stringify(j).slice(0, 200));
      }

      const html = j.data.html;
      const cards = parseCards(html, previousHtml);
      if (cards.length === 0) {
        if (html.trim() === '' || /No results found/i.test(html)) break; // the site answered: nothing listed
        return couldnt('layout_changed', PAGE, html.slice(0, 200));
      }

      if (page === 1) {
        const reported = Number(j.data.max_pages) || 1;
        if (reported > MAX_PAGES) return couldnt('other', PAGE, `directory search returned ${reported} pages, too many to read`);
        maxPages = reported;
      }

      for (const c of cards) {
        entries++;
        if (!firstText) firstText = c.text;
        const key = JSON.stringify(c.record);
        if (normalize(c.name) === target && !seen.has(key)) {
          seen.add(key);
          matches.push(c.record);
        }
      }
      previousHtml = html;
      page++;
    }

    const source_url = PAGE;
    if (matches.length) {
      const first = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url,
        excerpt: `${first.name} | ${first.category} | ${first.address}`.slice(0, 300),
      };
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url,
      excerpt: `Membership directory search "${search || '(all)'}" checked ${entries} entries; no member named "${input}"`,
    };
  } catch (err) {
    return couldnt('other', PAGE, String(err?.message || err));
  }
}
