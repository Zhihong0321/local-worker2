export const meta = {
  task: 'RU-russoft.org',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'participant_url', 'website', 'tags', 'description', 'staff', 'location', 'founded'],
  canary: { found: 'Auriga', not_found: 'ООО «Ромашка Тестовая Компания»' },
};

const MEMBERS_URL = 'https://russoft.org/members/';
const AJAX_URL = 'https://russoft.org/wp-admin/admin-ajax.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип', 'тоо', 'llc', 'ltd', 'jsc', 'pjsc', 'co', 'inc', 'corp', 'gmbh', 'ooo', 'oao', 'zao', 'pao']);
const MAX_MATCHES = 3;
const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalised name: lower case, ё=е, punctuation and legal-form words removed. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

/** The names one list entry can be matched by: full label, text before the bracket, the bracket text, the first comma part. */
function candidatesOf(label) {
  const full = label.trim();
  const main = full.replace(/\([^()]*\)/g, ' ').trim();
  const out = [full, main, main.split(',')[0]];
  for (const m of full.matchAll(/\(([^()]*)\)/g)) out.push(m[1]);
  return [...new Set(out.map(norm).filter(Boolean))];
}

function fail(reason, sourceUrl, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: sourceUrl, excerpt: String(excerpt || '').slice(0, 500) };
}

function failFromError(err, sourceUrl) {
  const name = err && err.name;
  if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', sourceUrl, 'no answer within 25 s');
  return fail('other', sourceUrl, String(err && err.message ? err.message : err));
}

/** Returns a fail() answer for a bad HTTP status or a block page, otherwise null. */
function badResponse(res, html, sourceUrl) {
  if (res.status === 403 || res.status === 429) return fail('blocked', sourceUrl, `HTTP ${res.status}`);
  if (/Just a moment|cf-browser-verification|cf-chl-|captcha/i.test(html || '')) return fail('blocked', sourceUrl, 'bot check page');
  if (!res.ok) return fail('http_error', sourceUrl, `HTTP ${res.status}`);
  return null;
}

/** Reads the full company list from the members page: [{ id, label }], plus the total the page states. */
async function loadIndex() {
  const res = await fetch(MEMBERS_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  const bad = badResponse(res, html, MEMBERS_URL);
  if (bad) return { fail: bad };

  const totalMatch = html.match(/member-page__subhead">\s*(\d[\d\s ]*)\s*Компан/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/\D/g, ''), 10) : NaN;
  const start = html.indexOf('name="titlefilter[]"');
  const end = start < 0 ? -1 : html.indexOf('</select>', start);
  if (!Number.isFinite(total) || start < 0 || end < 0) {
    return { fail: fail('layout_changed', MEMBERS_URL, 'no company count or company filter list on the members page') };
  }
  const block = html.slice(start, end);
  const index = [];
  for (const m of block.matchAll(/<option value="(\d+)">([\s\S]*?)<\/option>/g)) {
    const label = cleanText(m[2]);
    if (label) index.push({ id: m[1], label });
  }
  if (index.length < total) {
    return { fail: fail('layout_changed', MEMBERS_URL, `page says ${total} companies but only ${index.length} are listed`) };
  }
  return { index, total };
}

function parseCards(content) {
  return content.split('<div class="member">').slice(1).map((part) => {
    const info = {};
    for (const m of part.matchAll(/<svg class="[^"]*svg-icon-(employees|location|calendar)[^"]*"[\s\S]*?<span class="member-info__text">([\s\S]*?)<\/span>/g)) {
      info[m[1]] = cleanText(m[2]);
    }
    return {
      name: cleanText((part.match(/<div class="member__name">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]),
      participant_url: ((part.match(/<a class="link post_name"[^>]*href="\s*([^"]*?)\s*"/) || [])[1] || '').trim(),
      website: ((part.match(/<a class="link member__link[^"]*"[^>]*href="\s*([^"]*?)\s*"/) || [])[1] || '').trim(),
      tags: cleanText((part.match(/<div class="member__tags">([\s\S]*?)<\/div>/) || [])[1]),
      description: cleanText((part.match(/<div class="member__body">([\s\S]*?)<\/div>/) || [])[1]),
      staff: info.employees || '',
      location: info.location || '',
      founded: info.calendar || '',
    };
  }).filter((r) => r.name);
}

/** Loads the company card for one list id. Returns { cards } or { fail }. */
async function loadCard(entry) {
  const body = new URLSearchParams();
  body.append('action', 'participantFilter');
  body.append('view', 'main');
  body.append('memtype', '84');
  body.append('lang', 'ru');
  body.append('title[]', entry.id);
  const res = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': MEMBERS_URL,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  const bad = badResponse(res, text, AJAX_URL);
  if (bad) return { fail: bad };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { fail: fail('layout_changed', AJAX_URL, text.slice(0, 300)) };
  }
  if (!data || typeof data.content !== 'string') {
    return { fail: fail('layout_changed', AJAX_URL, 'reply has no content field') };
  }
  const cards = parseCards(data.content);
  if (!cards.length) return { fail: fail('layout_changed', AJAX_URL, `no card in reply for "${entry.label}"`) };
  return { cards };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const key = norm(keyword);
    if (!key) return fail('other', MEMBERS_URL, 'empty company name');

    const idx = await loadIndex();
    if (idx.fail) return idx.fail;

    const matches = idx.index.filter((e) => candidatesOf(e.label).includes(key)).slice(0, MAX_MATCHES);
    if (!matches.length) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: MEMBERS_URL,
        excerpt: `"${keyword}" is not among the ${idx.total} companies listed on ${MEMBERS_URL}`,
      };
    }

    const cardResults = await Promise.all(matches.map((e) => loadCard(e).catch((err) => ({ fail: failFromError(err, AJAX_URL) }))));
    const failed = cardResults.find((r) => r.fail);
    if (failed) return failed.fail;

    const records = cardResults.flatMap((r) => r.cards);
    const seen = new Set();
    const unique = records.filter((r) => {
      const k = r.participant_url || r.name;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return {
      status: 'found',
      reason: '',
      records: unique,
      source_url: MEMBERS_URL,
      excerpt: unique.map((r) => `${r.name} | ${r.tags} | ${r.description}`).join(' || ').slice(0, 500),
    };
  } catch (err) {
    return failFromError(err, MEMBERS_URL);
  }
}
