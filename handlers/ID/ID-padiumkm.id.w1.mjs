export const meta = {
  task: 'ID-padiumkm.id',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'store_name', 'company_type', 'status', 'pkp_status', 'address', 'city', 'province', 'csms_status', 'csms_level', 'created_at', 'updated_at', 'id'],
  canary: { found: 'PT. IGASAR', not_found: 'CV Usaha Fiktif Tidak Terdaftar' },
};

// PaDi UMKM public seller search (JSON, no login). Results are ranked by the site; the handler reads up to 3 pages
// of 50 and matches the normalised company name (and store name) exactly.
const SEARCH_URL = 'https://gatekeeper.padiumkm.id/buyer/store/search';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_LIMIT = 50;
const MAX_PAGES = 3;
const NEXT_PAGE_DEADLINE_MS = 20000;
const LEGAL_FORMS = new Set(['pt', 'cv', 'ud', 'tbk', 'persero', 'perum', 'fa', 'firma']);

/** Lower case, punctuation and spaces removed, legal form words dropped: "PT. MASKER" -> "masker". */
function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join('');
}

function searchUrl(keyword, page) {
  return `${SEARCH_URL}?page=${page}&limit=${PAGE_LIMIT}&keyword=${encodeURIComponent(keyword)}`;
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function toRecord(src) {
  return {
    name: src.name || '',
    store_name: src.store_name || '',
    company_type: src.company_type_name || '',
    status: src.status ?? null,
    pkp_status: src.pkp_status ?? null,
    address: src.address || '',
    city: src.city?.name || '',
    province: src.province?.name || '',
    csms_status: src.csms_status ?? null,
    csms_level: src.csms_level ?? null,
    created_at: src.createdAt || '',
    updated_at: src.updatedAt || '',
    id: src.id || '',
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let answer;
  try {
    answer = await run(keyword);
  } catch (err) {
    answer = couldnt('other', SEARCH_URL, String(err?.message || err));
  }
  // Let the just-closed HTTP socket settle before the runner calls process.exit(); on Windows an immediate exit
  // after fetch trips a libuv assertion (exit code 127) even though the answer was already printed.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  const kw = String(keyword || '').trim();
  const kwNorm = normalizeName(kw);
  const firstUrl = searchUrl(kw, 1);
  if (!kwNorm) return couldnt('other', firstUrl, 'name is empty once the legal form is removed');

  try {
    const matches = [];
    let matchUrl = firstUrl;
    let total = null;
    let lastPage = 0;
    let hasNext = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1 && Date.now() - started > NEXT_PAGE_DEADLINE_MS) break;
      const url = searchUrl(kw, page);
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return couldnt('blocked', url, `HTTP ${res.status}`);
      }
      if (!res.ok) return couldnt('http_error', url, `HTTP ${res.status}`);

      const text = await res.text();
      if (/captcha|cf-chl|challenge-platform/i.test(text.slice(0, 3000))) {
        return couldnt('blocked', url, 'bot check page');
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return couldnt('layout_changed', url, text.slice(0, 300));
      }
      const sellers = json?.data?.sellers;
      if (!Array.isArray(sellers)) return couldnt('layout_changed', url, text.slice(0, 300));

      const paginator = json.data.paginator || {};
      total = paginator.itemCount ?? total;
      lastPage = page;
      hasNext = Boolean(paginator.hasNextPage);

      for (const seller of sellers) {
        const src = seller?._source || {};
        if (normalizeName(src.name) === kwNorm || normalizeName(src.store_name) === kwNorm) {
          matches.push(toRecord(src));
        }
      }
      if (matches.length) {
        matchUrl = url;
        break;
      }
      if (!hasNext) break;
    }

    if (matches.length) {
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: matchUrl,
        excerpt: `${matches.length} listed seller(s) match "${kw}" (${total} search results in total)`,
      };
    }

    if (hasNext) {
      // Not every result was read, so an empty answer would not be a real "not listed".
      return couldnt('other', firstUrl, `no exact match in the first ${lastPage} pages (${PAGE_LIMIT} results each) of ${total} results`);
    }
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: firstUrl,
      excerpt: `0 sellers match "${kw}" (${total ?? 0} search results in total)`,
    };
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return couldnt('timeout', firstUrl, 'no answer within 25 s');
    }
    return couldnt('other', firstUrl, String(err?.message || err));
  }
}
