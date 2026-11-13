export const meta = {
  task: 'AR-bumeran.com.ar', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'company_id', 'industry', 'province', 'employee_count', 'job_postings', 'validated', 'description', 'profile_url'],
  canary: { found: 'Mercado Libre', not_found: 'Compañía Inexistente Zyxwvq S.A.' },
};

const SITE = 'https://www.bumeran.com.ar';
const SUGGEST = `${SITE}/api/companies/suggestion`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Argentine and common legal-form endings, matched only at the end of a name (lower case, accents removed).
const LEGAL_TAILS = [
  ['sociedad', 'anonima', 'industrial', 'comercial', 'y', 'financiera'],
  ['sociedad', 'anonima', 'comercial', 'industrial', 'y', 'financiera'],
  ['sociedad', 'de', 'responsabilidad', 'limitada'],
  ['sociedad', 'anonima'], ['sociedad', 'civil'],
  ['s', 'a', 'i', 'c', 'y', 'f'], ['s', 'a', 'i', 'c'], ['s', 'a', 'i'], ['s', 'a', 's'], ['s', 'a', 'u'],
  ['s', 'r', 'l'], ['s', 'c', 'a'], ['s', 'c', 's'], ['s', 'h'], ['s', 'e'], ['s', 'a'],
  ['sa'], ['srl'], ['sas'], ['saic'], ['sau'], ['sca'], ['scs'], ['ltda'], ['ltd'], ['limited'], ['inc'], ['llc'],
  ['corp'], ['corporation'], ['gmbh'], ['plc'], ['spa'], ['sl'],
];

/** Lower case, accents removed, every run of punctuation or spaces becomes one space. */
function tokens(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Name tokens without the legal form at the end ("ACME TRADING S.A." -> acme trading). */
function coreTokens(toks) {
  for (const tail of LEGAL_TAILS) {
    if (toks.length > tail.length && tail.every((t, i) => toks[toks.length - tail.length + i] === t)) {
      return toks.slice(0, toks.length - tail.length);
    }
  }
  return toks;
}

function slugForProfile(name) {
  // The same slug rule the site uses for its company profile links.
  return String(name).toLowerCase().trim().replace(/\//g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/([!#$%&‘()*+,/:;=?@[\]])/g, '').replace(/\s+/g, ' ').replace(/(\s)/g, '-').replace(/-+/g, '-')
    .replace(/[^\x00-\x7F]/g, '');
}

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return Array.from({ length: 32 }, hex).join('');
}

function headers() {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-AR,es;q=0.9',
    'x-site-id': 'BMAR',
    'x-pre-session-token': uuid(),
    'Referer': `${SITE}/`,
  };
}

/** Ask the site's own company suggestion endpoint. Returns { answer } or { fail }. */
async function ask(query) {
  const url = `${SUGGEST}?keyword=${encodeURIComponent(query)}&ignoreGptw=false`;
  let res;
  try {
    res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(25000) });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url, excerpt: String(err?.message || err).slice(0, 300) } };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 403 || res.status === 401 || res.status === 429 || /attention required|cloudflare|captcha/i.test(text.slice(0, 2000))) {
    return { fail: { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    return { fail: { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status} ${text.slice(0, 200)}` } };
  }
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!Array.isArray(data)) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: text.slice(0, 300) } };
  }
  return { answer: data, url };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const all = tokens(keyword);
    if (all.length === 0) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: SUGGEST, excerpt: 'no letters or digits in the company name' };
    }
    const core = coreTokens(all);
    const wantKey = core.join('');

    // The site's suggestion list is word-based, so search the name without its legal form first,
    // then the full name if that found nothing.
    const queries = [core.join(' ')];
    if (all.join(' ') !== core.join(' ')) queries.push(all.join(' '));

    let lastUrl = SUGGEST;
    for (const q of queries) {
      const r = await ask(q);
      if (r.fail) return r.fail;
      lastUrl = r.url;

      const matches = r.answer.filter((c) => c && typeof c.name === 'string' && coreTokens(tokens(c.name)).join('') === wantKey);
      if (matches.length > 0) {
        const records = matches.map((c) => ({
          name: c.name,
          company_id: c.companyId ?? null,
          industry: c.industry || '',
          province: c.province || '',
          employee_count: c.employeeCount ?? null,
          job_postings: c.jobPostingsQuantity ?? null,
          validated: c.validated ?? null,
          description: String(c.description || '').slice(0, 500),
          profile_url: c.companyId ? `${SITE}/perfiles/empresa_${slugForProfile(c.name)}_${c.companyId}.html` : '',
        }));
        return {
          status: 'found',
          reason: '',
          records,
          source_url: r.url,
          excerpt: `${records[0].name} | ${records[0].industry} | ${records[0].province} | ${records[0].job_postings} postings`,
        };
      }
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: lastUrl,
      excerpt: `Suggestion list has no company named like "${keyword}"`,
    };
  } catch (err) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: SUGGEST, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
