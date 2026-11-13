export const meta = {
  task: 'SG-cea.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_number', 'business_name', 'valid_from', 'valid_to', 'awards', 'disciplinary_actions'],
  canary: { found: 'PROPNEX REALTY PTE. LTD.', not_found: '新加坡虚构地产代理有限公司' },
};

const PAGE_URL = 'https://eservices.cea.gov.sg/aceas/public-register/';
const API_URL = 'https://eservices.cea.gov.sg/aceas/api/internet/profile/v2/public-register/filter';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that sit at the end of a company name (compared without dots, case and punctuation).
const LEGAL_WORDS = new Set(['PTE', 'LTD', 'LIMITED', 'PRIVATE', 'PVT', 'LLP', 'LLC', 'PLC', 'INC', 'SDN', 'BHD', 'BERHAD']);
const LEGAL_SUFFIXES_ZH = ['私人有限公司', '有限责任公司', '有限公司'];

/** The name without its legal form, keeping the words (used as the search text). */
function coreName(name) {
  let s = (name || '').normalize('NFKC').trim();
  for (const z of LEGAL_SUFFIXES_ZH) {
    if (s.endsWith(z)) { s = s.slice(0, -z.length).trim(); break; }
  }
  const words = s.split(/[\s.,&()/-]+/).filter(Boolean);
  while (words.length && LEGAL_WORDS.has(words[words.length - 1].toUpperCase())) words.pop();
  return words.join(' ');
}

/** Comparison key: case, punctuation, spacing and legal form ignored. Keeps letters of any script. */
function key(name) {
  return coreName(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function tooLong(started) {
  return Date.now() - started > 30000;
}

async function searchPage(core, page) {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://eservices.cea.gov.sg',
      'Referer': PAGE_URL,
    },
    body: JSON.stringify({ name: core, profileType: 1, page, pageSize: 100 }),
    signal: AbortSignal.timeout(25000),
  });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  try {
    const wanted = key(keyword);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: 'empty company name' };
    }
    const core = coreName(keyword) || String(keyword).trim();

    const items = [];
    let total = 0;
    for (let page = 1; ; page++) {
      const res = await searchPage(core, page);
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
      }
      let body;
      try { body = await res.json(); } catch {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: 'search did not return JSON' };
      }
      if (body?.status === 401 || body?.status === 403) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: String(body?.data?.message || `status ${body.status}`).slice(0, 200) };
      }
      if (body?.status !== 200 || !Array.isArray(body?.data)) {
        return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: JSON.stringify(body).slice(0, 300) };
      }
      items.push(...body.data);
      total = Number(body.totalItems) || 0;
      if (body.data.length === 0 || items.length >= total || page >= 10) break;
      if (tooLong(started)) break;
    }

    const matches = items.filter((r) => key(r.name) === wanted);
    const complete = items.length >= total;

    if (matches.length > 0) {
      return {
        status: 'found',
        reason: '',
        records: matches.map((r) => ({
          name: r.name,
          licence_number: r.licenseNumber ?? '',
          business_name: r.businessName ?? '',
          valid_from: r.validityDateStart ?? '',
          valid_to: r.validityDateEnd ?? '',
          awards: r.awards ?? null,
          disciplinary_actions: r.disciplinaryActions ?? null,
        })),
        source_url: PAGE_URL,
        excerpt: `Public Register estate agents: ${matches.length} match(es) for "${keyword}"`,
      };
    }

    if (!complete) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: PAGE_URL,
        excerpt: `read ${items.length} of ${total} results before the time limit; no exact match yet`,
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: PAGE_URL,
      excerpt: `Public Register returned ${items.length} result(s) for "${core}", none matching "${keyword}"`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PAGE_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
