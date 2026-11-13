export const meta = { task: 'RU-opora.ru', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'person', 'position', 'website'],
  canary: { found: 'ООО «СК Трейд»', not_found: 'ООО «Ромашка Тестовская»' } };

const LIST_URL = 'https://opora.ru/np-opora/spisok-chlenov/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal forms and long-form words that are dropped before comparing names.
const LEGAL_WORDS = new Set([
  'ооо', 'оао', 'зао', 'ао', 'пао', 'нао', 'нп', 'нко', 'ано', 'ип', 'тоо', 'оо',
  'общество', 'ограниченной', 'ответственностью', 'акционерное', 'публичное', 'непубличное',
  'открытое', 'закрытое', 'некоммерческое', 'партнерство', 'партнёрство',
]);

/** Normalised core of a company name: lower case, no quotes or punctuation, no legal form. */
function coreName(str) {
  const t = (str || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"'“”„‘’`´()\[\].,;:!?\-–—_\/\\&]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return t.split(' ').filter((w) => w && !LEGAL_WORDS.has(w)).join(' ');
}

function cleanText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"')
    .replace(/&laquo;|&raquo;/gi, '"').replace(/&mdash;|&ndash;/gi, '-').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: LIST_URL, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|ddos-guard|attention required|checking your browser/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: LIST_URL, excerpt: html.slice(0, 200) };
    }

    // The member list is one HTML table: person | organisation | position | website.
    const table = html.match(/<table[\s\S]*?<\/table>/i)?.[0] || '';
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || [])
      .map((tr) => (tr.match(/<td[\s\S]*?<\/td>/gi) || []))
      .filter((cells) => cells.length >= 4);

    if (!/Список членов/i.test(html) || rows.length < 10) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: LIST_URL, excerpt: cleanText(html).slice(0, 300) };
    }

    const members = rows.map((cells) => ({
      person: cleanText(cells[0]),
      name: cleanText(cells[1]),
      position: cleanText(cells[2]),
      website: cleanText(cells[3]),
    }));

    const kw = coreName(keyword);
    if (!kw) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: LIST_URL, excerpt: 'empty company name after normalising' };
    }

    const matches = members.filter((m) => coreName(m.name) === kw);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: LIST_URL,
        excerpt: `No organisation named "${keyword}" among ${members.length} members listed on the page`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: LIST_URL,
      excerpt: matches.map((m) => `${m.name} | ${m.person} | ${m.position}`).join(' ;; ').slice(0, 500),
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
