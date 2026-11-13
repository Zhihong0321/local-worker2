export const meta = {
  task: 'RU-deloros.ru',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: false,
  input: 'company name',
  fields: ['company', 'legal_form', 'person', 'role', 'person_url', 'category'],
  canary: { found: 'ООО «Закуптех»', not_found: 'ООО «Ромашка Тестовая»' },
};

const BASE = 'https://deloros.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// List pages of the organisation's leaders. Each card names a person and the company that person runs or sits on.
// The officer pages (/litsa/predsedatel/, /litsa/prezident/, ...) hold one person each and name no legal-form company, so they are not scanned.
const PAGES = [
  '/litsa/generalnyy-sovet/',
  '/regiony-v-litsakh/',
];

const LEGAL = 'ООО|АО|ПАО|ЗАО|ОАО|АНО|НАО|ИП';

function decode(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lower case, ё -> е, punctuation and quotes removed, so "ООО «Закуптех»" and "ооо Закуптех" compare equal.
function normName(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

// The keyword as typed: optional legal form at the start or the end, then the name.
function splitCompany(text) {
  let t = decode(text).replace(/[«»"“”„]/g, ' ').replace(/\s+/g, ' ').trim();
  let legal = '';
  const head = t.match(new RegExp('^(' + LEGAL + ')\\s+(.*)$', 'i'));
  const tail = t.match(new RegExp('^(.*)\\s+(' + LEGAL + ')$', 'i'));
  if (head) { legal = head[1].toUpperCase(); t = head[2]; }
  else if (tail) { legal = tail[2].toUpperCase(); t = tail[1]; }
  return { legal, name: normName(t) };
}

// Company names as the site writes them in a role line: "ООО «Name»", "ООО ГРУППА «Name»", "ООО Name".
// Only a name that carries a legal form counts, so a brand such as «Леонардо» on its own is not a company match.
function companyCandidates(text) {
  const out = [];
  const t = String(text || '');
  const quoted = new RegExp('(?:^|[^A-Za-zА-Яа-яЁё])(' + LEGAL + ')\\s+((?:[А-ЯЁ]{1,12}\\s+)*)[«"]([^«»"]{1,160})[»"]', 'g');
  let m;
  while ((m = quoted.exec(t))) {
    const prefix = (m[2] || '').trim();
    const content = m[3].trim();
    out.push({
      legal: m[1].toUpperCase(),
      name: normName((prefix ? prefix + ' ' : '') + content),
      raw: `${m[1].toUpperCase()} ${prefix ? prefix + ' ' : ''}«${content}»`,
    });
  }
  const plain = new RegExp('(?:^|[^A-Za-zА-Яа-яЁё])(' + LEGAL + ')\\s+([А-ЯЁA-Z][^\\s«»"“”„,;()]*(?:\\s+[^\\s«»"“”„,;()]+){0,3})', 'g');
  while ((m = plain.exec(t))) {
    out.push({ legal: m[1].toUpperCase(), name: normName(m[2]), raw: `${m[1].toUpperCase()} ${m[2].trim()}` });
  }
  return out;
}

function parseCards(html) {
  const cards = [];
  // Layout 1: card with a link to the person's own page.
  const a = /<a href="(\/litsa\/[^"]+)"[^>]*class="card[^"]*"[\s\S]*?card-faces-2-title[^"]*">([\s\S]*?)<\/div>\s*<div class="body-s[^"]*">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = a.exec(html))) {
    cards.push({ href: m[1], person: decode(m[2]), role: decode(m[3]) });
  }
  // Layout 2: regional leaders, name and role in plain blocks.
  const b = /<div class="card-man-content">[\s\S]*?<div class="h4 mb5">([\s\S]*?)<\/div>\s*<div class="body-s">([\s\S]*?)<\/div>/g;
  while ((m = b.exec(html))) {
    cards.push({ href: '', person: decode(m[1]), role: decode(m[2]) });
  }
  return cards;
}

async function getPage(path) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { path, url, error: 'blocked', detail: `HTTP ${res.status}` };
    if (!res.ok) return { path, url, error: 'http_error', detail: `HTTP ${res.status}` };
    const html = await res.text();
    const cards = parseCards(html);
    if (!cards.length) {
      const blockedLike = /captcha|cf-chl|ddos-guard/i.test(html);
      return { path, url, error: blockedLike ? 'blocked' : 'layout_changed', detail: 'no leadership cards on the page' };
    }
    return { path, url, cards };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { path, url, error: timedOut ? 'timeout' : 'other', detail: String(e?.message || e).slice(0, 200) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const sourceUrl = BASE + PAGES[0];
  try {
    const want = splitCompany(keyword);
    if (!want.name) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'empty company name' };
    }

    const pages = await Promise.all(PAGES.map(getPage));

    const records = [];
    const seen = new Set();
    let checked = 0;
    for (const p of pages) {
      if (p.error) continue;
      for (const card of p.cards) {
        checked++;
        for (const cand of companyCandidates(card.role)) {
          if (cand.name === want.name && (want.legal === '' || cand.legal === want.legal)) {
            const personUrl = card.href ? BASE + card.href : p.url;
            const key = cand.raw + '|' + card.person;
            if (seen.has(key)) continue;
            seen.add(key);
            records.push({
              company: cand.raw,
              legal_form: cand.legal,
              person: card.person,
              role: card.role,
              person_url: personUrl,
              category: p.path,
            });
          }
        }
      }
    }

    if (records.length) {
      return {
        status: 'found',
        reason: '',
        records,
        source_url: records[0].person_url,
        excerpt: records[0].role.slice(0, 400),
      };
    }

    // A page that could not be read might hold the company, so an unread page is never a "not found".
    const failed = pages.filter((p) => p.error);
    if (failed.length) {
      const order = ['blocked', 'timeout', 'http_error', 'layout_changed', 'other'];
      failed.sort((a, b) => order.indexOf(a.error) - order.indexOf(b.error));
      const f = failed[0];
      return {
        status: 'couldnt_check',
        reason: f.error,
        records: [],
        source_url: f.url,
        excerpt: `${failed.length} of ${PAGES.length} pages could not be read; ${f.path}: ${f.detail}`.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: sourceUrl,
      excerpt: `Checked ${checked} leadership entries on ${PAGES.length} pages; no company matched ${keyword}`.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 500),
    };
  }
}
