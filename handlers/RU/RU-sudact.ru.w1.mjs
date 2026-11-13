export const meta = {
  task: 'RU-sudact.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['case', 'court', 'doc_url', 'snippet'],
  canary: { found: 'ПАО Сбербанк', not_found: 'ООО «Зефирная Ромашка Тестовая Фабрика»' },
};

const BASE = 'https://sudact.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Legal-form words are dropped before comparing, so "ООО «ТРК»" and "ООО ТРК" compare as "трк".
const LEGAL_FORMS = new Set(['ооо', 'ао', 'оао', 'зао', 'пао', 'нао', 'ип', 'тоо', 'llc', 'ltd', 'jsc', 'pjsc']);
// The site builds results in the background: keep asking while it says "new", but never start a request after 30 s.
const POLL_START_LIMIT_MS = 30000;
const POLL_WAIT_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|laquo|raquo|quot|amp|ndash|mdash|#171|#187);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function coreTokens(name) {
  return tokens(name).filter((t) => !LEGAL_FORMS.has(t));
}

function containsRun(haystack, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Turns the results <ul> into items: { id, title, court, text, snippet }. */
function parseItems(content) {
  const block = content.match(/<ul class="results">[\s\S]*<\/ul>/);
  if (!block) return [];
  const chunks = block[0].split(/<li>/).slice(1);
  const items = [];
  for (const li of chunks) {
    const link = li.match(/<a href="\/regular\/doc\/([^/"]+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const jm = li.match(/<div class="b-justice">([\s\S]*?)<\/div>/);
    const court = jm ? clean(jm[1]) : '';
    const snippetHtml = jm ? li.slice(li.indexOf(jm[0]) + jm[0].length) : li;
    const snippet = clean(snippetHtml);
    const title = clean(link[2]);
    items.push({ id: link[1], title, court, snippet, text: `${title} ${court} ${snippet}` });
  }
  return items;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const name = String(keyword || '').trim();
    const core = coreTokens(name);
    if (!name || !core.length) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: 'empty or legal-form-only name' };
    }

    const params = new URLSearchParams({
      'regular-txt': name,
      'regular-workflow_stage': '',
      'regular-area': '',
      'regular-date_from': '',
      'regular-date_to': '',
    });
    const pageUrl = `${BASE}/regular/doc/?${params.toString()}`;
    const ajaxUrl = `${BASE}/regular/doc_ajax/?${params.toString()}`;
    const headers = {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': pageUrl,
    };

    let json = null;
    for (;;) {
      let res;
      try {
        res = await fetch(ajaxUrl, { headers, signal: AbortSignal.timeout(25000) });
      } catch (e) {
        const timed = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return { status: 'couldnt_check', reason: timed ? 'timeout' : 'other', records: [], source_url: pageUrl, excerpt: String(e?.message || e).slice(0, 200) };
      }
      if (res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pageUrl, excerpt: `HTTP ${res.status}` };
      }
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        const blocked = /captcha|smartcaptcha|challenge/i.test(text);
        return { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', records: [], source_url: pageUrl, excerpt: clean(text).slice(0, 300) };
      }
      const stillWorking = typeof json.content !== 'string' || json.status === 'new' || json.search_status === 'new';
      if (!stillWorking) break;
      if (Date.now() - started > POLL_START_LIMIT_MS) {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: pageUrl, excerpt: 'the site did not finish the search in time' };
      }
      await sleep(POLL_WAIT_MS);
    }

    const content = json.content;
    const totalText = clean(json.total_found || '');
    if (/<div class="prompting3 alert">/.test(content)) {
      const err = clean(content.match(/<div class="prompting3 alert">([\s\S]*?)<\/div>/)?.[1] || '');
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: pageUrl, excerpt: err.slice(0, 300) };
    }

    // The site says "По Вашему запросу документов не найдено" when the exact search is empty; the list under it is only
    // loosely matched "you may have meant" documents, so it is not treated as a hit.
    if (/документов не найдено/i.test(content)) {
      return { status: 'not_found', reason: '', records: [], source_url: pageUrl, excerpt: clean(content).slice(0, 200) };
    }

    const items = parseItems(content);
    if (items.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pageUrl, excerpt: clean(content).slice(0, 300) };
    }

    const matches = items.filter((it) => containsRun(tokens(it.text), core));
    const summary = `${totalText}; listing shows ${items.length} documents, ${matches.length} name the company`;
    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: pageUrl, excerpt: summary };
    }
    return {
      status: 'found',
      reason: '',
      records: matches.map((it) => ({
        case: it.title,
        court: it.court,
        doc_url: `${BASE}/regular/doc/${it.id}/`,
        snippet: it.snippet.slice(0, 700),
      })),
      source_url: pageUrl,
      excerpt: summary,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: BASE, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
