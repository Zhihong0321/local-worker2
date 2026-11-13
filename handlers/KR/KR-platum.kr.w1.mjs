export const meta = {
  task: 'KR-platum.kr',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'profile_url', 'profile_date'],
  canary: { found: '당근', not_found: '데젠노비아트릭스전혀없음' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://www.platum.kr';

// Legal-form words that do not change the company name (Korean and English).
const LEGAL_KO = ['주식회사', '유한책임회사', '유한회사', '합자회사', '합명회사', '사단법인', '재단법인', '(주)', '(유)', '㈜'];

/** Remove legal-form words and punctuation, lowercase. Used on both the typed name and the site's titles. */
function normalize(str) {
  let s = (str || '').normalize('NFKC').toLowerCase();
  for (const w of LEGAL_KO) s = s.split(w.toLowerCase()).join(' ');
  s = s.replace(/\b(co\.?\s*,?\s*ltd\.?|inc\.?|corp\.?|llc\.?|limited|ltd\.?)(?=\W|$)/g, ' ');
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The search term: the typed name with legal-form words removed, spaces kept (WordPress search is substring based). */
function searchTerm(keyword) {
  let s = (keyword || '').normalize('NFKC');
  for (const w of LEGAL_KO) s = s.split(w).join(' ');
  s = s.replace(/\b(Co\.?\s*,?\s*Ltd\.?|Inc\.?|Corp\.?|LLC\.?|Limited|Ltd\.?)(?=\W|$)/gi, ' ');
  return s.replace(/\s+/g, ' ').trim() || (keyword || '').trim();
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, '').trim();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const term = searchTerm(keyword);
  const apiUrl = `${BASE}/wp-json/wp/v2/company?search=${encodeURIComponent(term)}&per_page=100&_fields=id,date,link,title`;
  const fail = (reason, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url: apiUrl, excerpt: String(excerpt || '').slice(0, 300) });

  if (!term) return fail('other', 'empty company name');

  let res, text;
  try {
    res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return fail('timeout', 'no answer within 25 s');
    return fail('other', String(err?.message || err));
  }

  if (res.status === 401 || res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
  if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

  if (/captcha|cf-browser-verification|just a moment|challenge-platform/i.test(text)) return fail('blocked', 'bot check page');

  let items;
  try {
    items = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return fail('layout_changed', text.slice(0, 300));
  }
  // A WordPress error object (for example rest_no_route) is not a list of companies.
  if (!Array.isArray(items)) return fail('layout_changed', text.slice(0, 300));

  const wanted = normalize(keyword);
  const matches = items.filter((it) => it && typeof it.title?.rendered === 'string'
    && normalize(decodeEntities(it.title.rendered)) === wanted && wanted !== '');

  if (matches.length === 0) {
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: apiUrl,
      excerpt: `Platum company list: ${items.length} entr${items.length === 1 ? 'y' : 'ies'} for "${term}", none with the same name`,
    };
  }

  const records = matches.map((it) => ({
    name: decodeEntities(it.title.rendered),
    profile_url: typeof it.link === 'string' ? it.link : '',
    profile_date: typeof it.date === 'string' ? it.date : '',
  }));

  return {
    status: 'found',
    reason: '',
    records,
    source_url: apiUrl,
    excerpt: `Platum company list entry: ${records.map((r) => r.name).join(', ')}`.slice(0, 300),
  };
}
