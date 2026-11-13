export const meta = {
  task: 'RU-vc.ru',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'url', 'description', 'subscribers'],
  canary: { found: 'Сбер', not_found: 'Дезено Холдинг' },
};

// Legal-form words are removed before the search: the vc.ru search returns nothing for "ООО Яндекс".
const LEGAL = new Set([
  'ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип', 'тоо', 'гуп', 'муп', 'фгуп', 'ано',
  'llc', 'ltd', 'limited', 'jsc', 'pjsc', 'inc', 'corp', 'gmbh', 'plc', 'ooo', 'oao', 'zao', 'pao', 'ip',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function tokens(s) {
  return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function coreTokens(s) {
  return tokens(s).filter((t) => !LEGAL.has(t));
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchUrl = '';
  try {
    const core = coreTokens(keyword);
    if (core.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: '', excerpt: 'no company name left after removing the legal form' };
    }
    const query = core.join(' ');
    const url = `https://api.vc.ru/v2.0/search?query=${encodeURIComponent(query)}`;

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ru,en;q=0.8' },
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { status: 'couldnt_check', reason: isTimeout ? 'timeout' : 'other', records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 200) };
    }

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'response is not JSON' };
    }

    // A normal answer with no profiles has no subsites key (only lastId, or contents), so that is an empty list.
    const result = json?.result;
    if (!result || typeof result !== 'object') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'no result object in the response' };
    }
    const hasSubsites = result.subsites && typeof result.subsites === 'object';
    if (!hasSubsites && !('lastId' in result) && !Array.isArray(result.contents)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'no subsites, contents or lastId in the response' };
    }
    const users = hasSubsites && Array.isArray(result.subsites.users) ? result.subsites.users : [];

    const kwFull = tokens(keyword).join('');
    const kwCore = core.join('');
    const latin = !/\p{Script=Cyrillic}/u.test(keyword || '');

    const matches = users.filter((u) => {
      const name = String(u?.name || '');
      if (!name) return false;
      const sFull = tokens(name).join('');
      const sCore = coreTokens(name).join('');
      if (sFull === kwFull || (sCore && sCore === kwCore)) return true;
      // Latin input only: the profile address (vc.ru/<slug>) is the same handle as the company's Latin name.
      if (latin && u.uri) {
        const slug = String(u.uri).replace(/^\//, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return slug === kwCore;
      }
      return false;
    });

    if (matches.length === 0 && latin) {
      // vc.ru profile names are mostly Cyrillic and a Latin query does not reach them, so "no match" proves nothing.
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: url,
        excerpt: `Latin-only name "${keyword}": vc.ru search does not match Cyrillic profile names, cannot confirm absence`,
      };
    }

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `vc.ru search for "${query}" returned ${users.length} profile(s), none with this name`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches.map((u) => ({
        name: String(u.name),
        url: u.uri ? `https://vc.ru${u.uri}` : '',
        description: String(u.description || ''),
        subscribers: typeof u.counterSubscribers === 'number' ? u.counterSubscribers : null,
      })),
      source_url: url,
      excerpt: matches.map((u) => `${u.name}${u.uri ? ' (vc.ru' + u.uri + ')' : ''}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: String(err?.message || err).slice(0, 200) };
  }
}
