export const meta = {
  task: 'RU-nostroy.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'short_name', 'inn', 'ogrn_ogrnip', 'registration_number', 'status', 'member_type', 'region',
    'registry_registration_date', 'sro', 'sro_registration_number', 'inventory_number', 'site_id'],
  canary: { found: 'Общество с ограниченной ответственностью «Ромашка»', not_found: 'ООО «Несуществующая Компания Фантазия 9999»' },
};

// The register's search API (the page https://reestr.nostroy.ru/sro/all/member/list posts to it).
// It is a substring match on the full name, case-insensitive, punctuation-sensitive.
const API = 'https://reestr.nostroy.ru/api/';
const PUBLIC_PAGE = 'https://reestr.nostroy.ru/sro/all/member/list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = '20';
const MAX_PAGES = 3;
const NO_NEW_REQUEST_AFTER_MS = 30000; // each fetch can take up to 25 s; keep the whole call under 60 s
const CYRILLIC = /[Ѐ-ӿ]/;

// Legal forms as the register writes them (full and short). Longest first so the full phrase wins.
const LEGAL_FORMS = [
  'общество с ограниченной ответственностью', 'общество с ограниченной отвественностью',
  'акционерное общество с ограниченной ответственностью', 'закрытое акционерное общество',
  'открытое акционерное общество', 'публичное акционерное общество', 'непубличное акционерное общество',
  'акционерное общество', 'производственный кооператив', 'индивидуальный предприниматель',
  'ооо', 'зао', 'оао', 'пао', 'нао', 'ао', 'ип',
].sort((a, b) => b.length - a.length);
const LEGAL_RE = new RegExp('(?<![\\p{L}\\p{N}])(?:' + LEGAL_FORMS.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');

class CouldntCheck extends Error {
  constructor(reason, detail) { super(detail); this.reason = reason; }
}

/** Lower case, ё as е, punctuation and legal form removed, a leading "000" (the register writes ООО so) removed. */
function normalise(text) {
  return (text || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(LEGAL_RE, ' ')
    .replace(/^\s*000(?=\s|$)/, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Comparison key: the normalised name with spaces removed. */
const keyOf = (text) => normalise(text).replace(/ /g, '');

/** The name as typed, without quotes, legal form or a leading "000"; this is what the site search gets. */
function searchTerm(input) {
  return input.replace(LEGAL_RE, ' ').replace(/[«»"“”„]/g, ' ')
    .replace(/^\s*000(?=\s)/, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s\-.,;:]+|[\s\-.,;:]+$/g, '').trim();
}

/** A record matches when its full name, short name or one part of them (split on ; ( ) and "former name") is the same company. */
function isMatch(rec, wantKey) {
  const whole = [rec.full_description, rec.short_description].filter(Boolean);
  const parts = whole.flatMap((p) => p.split(/[;()]|прежнее наименование|ранее/i));
  return [...whole, ...parts].some((c) => keyOf(c) === wantKey);
}

/** One POST to the search API. Returns the register's data object {data: [...], count, ...}. */
async function fetchPage(term, page) {
  let text;
  let status;
  try {
    const res = await fetch(API + 'sro/all/member/list', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({ filters: { full_description: term }, page, pageCount: PAGE_SIZE, sortBy: {} }),
      signal: AbortSignal.timeout(25000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new CouldntCheck(timedOut ? 'timeout' : 'other', String(e?.message || e));
  }
  if (status === 403 || status === 429 || /ddos-guard|captcha/i.test(text.slice(0, 2000))) {
    throw new CouldntCheck('blocked', `HTTP ${status}, bot or access check page`);
  }
  if (status !== 200) throw new CouldntCheck('http_error', `HTTP ${status}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new CouldntCheck('layout_changed', 'not JSON: ' + text.slice(0, 200)); }
  if (json.success === false) throw new CouldntCheck('other', 'site error: ' + String(json.message || '').slice(0, 200));
  if (!json.data || !Array.isArray(json.data.data) || typeof json.data.count !== 'number') {
    throw new CouldntCheck('layout_changed', 'unexpected JSON: ' + text.slice(0, 200));
  }
  return json.data;
}

/** Reads result pages until the name is matched, all results are read, or the page limit or time limit is reached. */
async function searchAll(term, wantKey, start) {
  const first = await fetchPage(term, 1);
  const items = [...first.data];
  let count = first.count;
  let page = 1;
  while (!items.some((r) => isMatch(r, wantKey)) && items.length < count && page < MAX_PAGES
         && Date.now() - start < NO_NEW_REQUEST_AFTER_MS) {
    page += 1;
    const more = await fetchPage(term, page);
    if (!more.data.length) break;
    items.push(...more.data);
    count = more.count;
  }
  return { count, items, matched: items.filter((r) => isMatch(r, wantKey)), complete: items.length >= count };
}

function toRecord(rec) {
  return {
    name: rec.full_description || '',
    short_name: rec.short_description || '',
    inn: rec.inn || '',
    ogrn_ogrnip: rec.ogrnip || '',
    registration_number: rec.registration_number || '',
    status: rec.member_status?.title || '',
    member_type: rec.member_type?.title || '',
    region: rec.region_number?.title || '',
    registry_registration_date: rec.registry_registration_date || '',
    sro: rec.sro?.full_description || '',
    sro_registration_number: rec.sro?.registration_number || '',
    inventory_number: rec.inventory_number || '',
    site_id: rec.id ?? null,
  };
}

async function lookupOnce(keyword) {
  const start = Date.now();
  const input = String(keyword || '').trim();
  try {
    const term = searchTerm(input);
    const wantKey = keyOf(term);
    if (!wantKey) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PUBLIC_PAGE,
        excerpt: 'no company name left after removing the legal form' };
    }

    const first = await searchAll(term, wantKey, start);
    let matched = first.matched;
    let items = first.items;
    let complete = first.complete;
    let altTerm = '';

    // The search is punctuation-sensitive ("Строй-Инвест" is not "Строй Инвест"): try the other separator once.
    const alt = term.includes('-') ? term.replace(/-/g, ' ') : (term.includes(' ') ? term.replace(/ /g, '-') : '');
    if (!matched.length && alt && Date.now() - start < NO_NEW_REQUEST_AFTER_MS) {
      const second = await searchAll(alt, wantKey, start);
      altTerm = alt;
      matched = second.matched;
      items = [...items, ...second.items];
      complete = complete && second.complete;
    }

    if (matched.length) {
      const names = matched.map((r) => `${r.full_description} [${r.member_status?.title || 'status ?'}]`).join('; ');
      return {
        status: 'found', reason: '', records: matched.map(toRecord), source_url: PUBLIC_PAGE,
        excerpt: `${matched.length} exact match(es) for "${input}" (search "${term}"${altTerm ? ` and "${altTerm}"` : ''}): ${names}`.slice(0, 500),
      };
    }
    if (!complete) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PUBLIC_PAGE,
        excerpt: `search "${term}" returned ${first.count} results; read ${items.length}, none is "${input}" after normalising; not all results were read` };
    }
    if (!CYRILLIC.test(input)) {
      // The register lists Russian companies in Cyrillic: a Latin name that is not found does not prove absence.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PUBLIC_PAGE,
        excerpt: `latin-script name "${input}": the register lists Russian names in Cyrillic, so no match here does not show the company is absent` };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: PUBLIC_PAGE,
      excerpt: `search "${term}" returned ${first.count} result(s); none is "${input}" after normalising legal form and punctuation`,
    };
  } catch (err) {
    if (err instanceof CouldntCheck) {
      return { status: 'couldnt_check', reason: err.reason, records: [], source_url: PUBLIC_PAGE, excerpt: String(err.message).slice(0, 300) };
    }
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: PUBLIC_PAGE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const result = await lookupOnce(keyword);
  // Let the keep-alive sockets of the last request close before the caller ends the process (Windows, Node 24).
  await new Promise((resolve) => setTimeout(resolve, 300));
  return result;
}
