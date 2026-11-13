export const meta = {
  task: 'RU-2gis.ru',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'address', 'city', 'firm_id', 'firm_url', 'card_text'],
  canary: { found: 'СберБанк', not_found: 'КвазарнаяФирмаНетест' },
};

// 2GIS has no country-wide search (/russia/search/... is a 404). Each city has its own search page, so the handler
// asks the five largest cities in parallel. A city that answers normally is never assumed to hold every company.
const CITIES = [
  { slug: 'moscow', label: 'Москва' },
  { slug: 'spb', label: 'Санкт-Петербург' },
  { slug: 'novosibirsk', label: 'Новосибирск' },
  { slug: 'ekaterinburg', label: 'Екатеринбург' },
  { slug: 'kazan', label: 'Казань' },
];

// A current desktop Chrome UA. Chrome/120 is sent to 2GIS's "outdated browser" page (/museum), which is not a result.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Legal forms are dropped before comparing, so "ООО «Ромашка»" and "Ромашка" compare equal.
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'нко', 'гуп', 'муп', 'фгуп', 'тоо', 'llc', 'ltd', 'inc', 'jsc']);

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Card blocks of a 2GIS search page: one <a href="/<city>/firm/<id>"> per company. */
function parseCards(html) {
  const anchors = [...html.matchAll(/<a href="\/([a-z_]+)\/firm\/(\d+)"[^>]*>/g)];
  const cards = [];
  const seen = new Set();
  anchors.forEach((m, i) => {
    const [, citySlug, firmId] = m;
    if (seen.has(firmId)) return;
    seen.add(firmId);
    const start = m.index;
    const next = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const seg = html.slice(start, next);
    const nameMatch = seg.match(/<span>([^<]+)<\/span>/);
    if (!nameMatch) return;
    const lines = decode(
      seg
        .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<[^>]+>/g, '\n')
    )
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l && l.length < 200 && !/[{}]/.test(l));
    const name = decode(nameMatch[1]).trim();
    const legalName = lines.find((l) => /^(ООО|ОАО|ЗАО|ПАО|АО|ИП)\s/.test(l)) || '';
    const address = lines.find((l) => /\d/.test(l) && l.includes(',') && !/оцен|филиал|Закрыто|Открыто|Работает/.test(l)) || '';
    cards.push({
      name,
      legal_name: legalName,
      address,
      city: citySlug,
      firm_id: firmId,
      firm_url: `https://2gis.ru/${citySlug}/firm/${firmId}`,
      card_text: lines.join(' | ').slice(0, 300),
    });
  });
  return cards;
}

async function searchCity(city, keyword) {
  const url = `https://2gis.ru/${city.slug}/search/${encodeURIComponent(keyword)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ru-RU,ru;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    if (res.url.includes('/museum')) return { city, url, state: 'blocked', detail: 'redirected to the outdated-browser page' };
    if (res.status === 403 || res.status === 429) return { city, url, state: 'blocked', detail: `HTTP ${res.status}` };
    const cards = parseCards(html);
    if (cards.length) return { city, url, state: 'ok', cards };
    if (html.includes('Ничего не нашлось')) return { city, url, state: 'empty', cards: [] };
    if (res.ok) return { city, url, state: 'layout_changed', detail: 'no company cards and no "nothing found" text' };
    return { city, url, state: 'http_error', detail: `HTTP ${res.status}` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { city, url, state: timedOut ? 'timeout' : 'other', detail: String(err?.message || err).slice(0, 200) };
  }
}

const PRIORITY = ['blocked', 'layout_changed', 'http_error', 'timeout', 'other'];

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const target = normalize(keyword);
    if (!target) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'empty company name after normalising' };
    }

    const results = await Promise.all(CITIES.map((c) => searchCity(c, keyword)));

    const records = [];
    for (const r of results) {
      if (r.state !== 'ok') continue;
      for (const card of r.cards) {
        if (normalize(card.name) === target || (card.legal_name && normalize(card.legal_name) === target)) {
          records.push({
            name: card.name,
            legal_name: card.legal_name,
            address: card.address,
            city: CITIES.find((c) => c.slug === card.city)?.label || card.city,
            firm_id: card.firm_id,
            firm_url: card.firm_url,
            card_text: card.card_text,
          });
        }
      }
    }

    if (records.length) {
      const firstCity = results.find((r) => r.state === 'ok' && r.cards.some((c) => records.some((x) => x.firm_id === c.firm_id)));
      return {
        status: 'found',
        reason: '',
        records,
        source_url: firstCity ? firstCity.url : records[0].firm_url,
        excerpt: records[0].card_text,
      };
    }

    // Nothing matched. Only a clean answer from every city counts as not_found; any refusal or error keeps the verdict open.
    const failed = results.filter((r) => !['ok', 'empty'].includes(r.state));
    if (failed.length) {
      const reason = PRIORITY.find((p) => failed.some((r) => r.state === p)) || 'other';
      const first = failed.find((r) => r.state === reason);
      return {
        status: 'couldnt_check',
        reason,
        records: [],
        source_url: first.url,
        excerpt: failed.map((r) => `${r.city.slug}: ${r.state}${r.detail ? ' (' + r.detail + ')' : ''}`).join('; ').slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: results[0].url,
      excerpt: `No 2GIS card matches "${keyword}" in ${CITIES.map((c) => c.label).join(', ')} (2GIS has no country-wide search).`,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: '',
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
