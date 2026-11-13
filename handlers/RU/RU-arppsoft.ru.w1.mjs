export const meta = { task: 'RU-arppsoft.ru', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'legal_name', 'member_url', 'description'],
  canary: { found: '1С-Битрикс', not_found: 'Ромашка Нонексистент' } };

const BASE = 'https://arppsoft.ru';
const SEARCH = `${BASE}/members/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped before comparing names.
const LEGAL = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'фгуп', 'гуп', 'муп', 'нпо', 'гк',
  'ooo', 'oao', 'zao', 'pao', 'ao', 'llc', 'ltd', 'jsc', 'inc', 'co']);
// Latin letters that look like Cyrillic ones (e.g. "1C" typed with Latin C), mapped on both sides.
const LOOKALIKE = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', h: 'н', t: 'т', b: 'в' };

function decode(s) {
  return (s || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&quot;/gi, '"').replace(/&laquo;|&raquo;/gi, '"')
    .replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(lt|gt);/gi, (_, n) => (n.toLowerCase() === 'lt' ? '<' : '>'));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparison key: lower case, no punctuation, no legal form, Latin look-alikes mapped to Cyrillic. */
function key(s) {
  return cleanText(s).toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL.has(t)).join('')
    .replace(/[a-z]/g, (ch) => LOOKALIKE[ch] || ch);
}

/** Search text sent to the site: quotes and legal-form words removed, the rest kept as typed. */
function searchTerm(keyword) {
  return cleanText(keyword).replace(/[«»"“”„'`]/g, ' ').split(' ')
    .filter((t) => t && !LEGAL.has(t.toLowerCase().replace(/[.,]/g, ''))).join(' ').trim();
}

/** Names a directory card can be known by: its title, a name in brackets, and the "ООО «…»" name in its text. */
function cardNames(title, text) {
  const names = [title];
  for (const m of title.matchAll(/\(([^)]+)\)/g)) names.push(m[1]);
  for (const m of text.matchAll(/(?:ООО|АО|ПАО|ЗАО|ОАО|ИП|ФГУП|ГУП|МУП|НПО|OOO|LLC)\s*[«"“]([^»"”]+)[»"”]/gi)) names.push(m[0]);
  return names;
}

const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru,en;q=0.8' };

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let url = SEARCH;
  try {
    const term = searchTerm(keyword);
    const k = key(keyword);
    if (!term || !k) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SEARCH,
        excerpt: 'no company name to search for' };
    }
    url = `${SEARCH}?q=${encodeURIComponent(term)}`;

    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    const html = await res.text();

    // The result page states how many members matched the search, then lists them in one <ul class="list-posts">.
    const head = html.match(/найдено членов[\s\S]*?<b>\s*(\d+)\s*<\/b>/);
    if (!head) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
        excerpt: cleanText(html).slice(0, 300) };
    }
    const count = Number(head[1]);
    const after = html.slice(head.index + head[0].length);
    const listStart = after.indexOf('<ul class="list-posts">');
    const listEnd = listStart < 0 ? -1 : after.indexOf('</ul>', listStart);
    const block = listStart < 0 || listEnd < 0 ? '' : after.slice(listStart, listEnd);
    const cards = block.split(/<li class="clearfix"/).slice(1);
    if (cards.length !== count) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
        excerpt: `count says ${count}, parsed ${cards.length} cards` };
    }

    const hits = [];
    const similar = [];
    for (const card of cards) {
      const link = card.match(/<h4[^>]*>\s*<a href="(\/members\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url,
          excerpt: 'a result card has no name link' };
      }
      const title = cleanText(link[2]);
      const body = card.slice(card.indexOf('</h4>') + 5);
      const text = cleanText(body).replace(/Подробнее\s*$/, '').trim();
      similar.push(title);
      const names = cardNames(title, body);
      const matched = names.find((n) => key(n) === k);
      if (matched !== undefined) {
        hits.push({
          name: title,
          legal_name: cleanText(matched),
          member_url: new URL(link[1], BASE).href,
          description: text.slice(0, 400),
        });
      }
    }

    if (hits.length) {
      return { status: 'found', reason: '', records: hits, source_url: url,
        excerpt: hits.map((h) => `${h.name} | ${h.legal_name} | ${h.member_url}`).join(' ; ').slice(0, 500) };
    }
    return { status: 'not_found', reason: '', records: [], source_url: url,
      excerpt: count === 0 ? `0 members match "${term}"`
        : `${count} member(s) match "${term}" but none has this name: ${similar.join(', ')}`.slice(0, 500) };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: url,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
