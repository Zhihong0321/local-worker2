export const meta = {
  task: 'NZ-rea.govt.nz',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'licence_number', 'licence_type', 'licence_class', 'status', 'trading_names', 'franchise_group',
    'business_address', 'registered_office_address', 'date_first_registered', 'licence_period', 'expiry_date',
    'work_types', 'suburb', 'town_city'],
  canary: { found: 'Hamill Realty Limited', not_found: 'Ngahere Tuatahi Realty Limited' },
};

const SEARCH = 'https://publicregister.rea.govt.nz/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DETAIL_BUDGET_MS = 30000; // do not start another detail page after this much time
const MAX_DETAILS = 3;

function decode(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'");
}

function clean(html) {
  return decode((html || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/(\s*,\s*)+/g, ', ')
    .replace(/^,\s*|,\s*$/g, '')
    .trim();
}

/** Compare names: case, accents, punctuation and a trailing legal form (Limited / Ltd / Incorporated / Inc) ignored. */
function core(str) {
  let s = (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/\s(limited|ltd|incorporated|inc)$/, '');
  } while (s !== prev);
  return s.trim();
}

/** The text sent to the site's search box: the name as typed, minus a trailing legal form (the site matches substrings). */
function searchText(keyword) {
  let s = (keyword || '').trim().replace(/[\s,.]+$/, '');
  let prev;
  do {
    prev = s;
    s = s.replace(/[\s,]+(limited|ltd|incorporated|inc)\.?$/i, '').trim();
  } while (s !== prev);
  return s || (keyword || '').trim();
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function looksBlocked(html) {
  return /captcha|incapsula|cf-chl|access denied|request unsuccessful|are you a robot/i.test(html);
}

async function get(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-NZ,en;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** Result rows of the business-name search: { id, href, name, suburb, town, status }. */
function parseRows(html, base) {
  const table = html.match(/<table class="table table-hover">([\s\S]*?)<\/table>/i);
  if (!table) return [];
  const rows = [];
  const re = /<tr[^>]*>\s*<td[^>]*>\s*<a href="([^"]*licenceid=[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = re.exec(table[1]))) {
    rows.push({
      href: new URL(decode(m[1]), base).href,
      name: clean(m[2]),
      suburb: clean(m[3]),
      town: clean(m[4]),
      status: clean(m[5]),
    });
  }
  return rows;
}

/** Licence detail page: label/value pairs in <div class="col-md-4 fw-semibold">label</div><div class="col-md-8">value</div>. */
function parseDetail(html) {
  const out = {};
  const re = /<div class="col-md-4 fw-semibold">\s*([^<]*?)\s*<\/div>\s*<div class="col-md-8">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = clean(m[1]);
    if (!(label in out)) out[label] = clean(m[2]);
  }
  return out;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const q = searchText(keyword);
  const searchUrl = `${SEARCH}?searchOption=3&org=${encodeURIComponent(q)}`;
  try {
    const res = await get(searchUrl);
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return fail('blocked', searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) return fail('http_error', searchUrl, `HTTP ${res.status}`);

    const html = await res.text();
    if (looksBlocked(html)) return fail('blocked', searchUrl, 'bot or captcha page');

    const countMatch = html.match(/Result\s*-\s*(\d+)\s*found/i);
    const noMatch = /No matches were found/i.test(html);
    if (!countMatch && !noMatch) return fail('layout_changed', searchUrl, html.slice(0, 300));

    const total = countMatch ? Number(countMatch[1]) : 0;
    const rows = parseRows(html, searchUrl);
    if (total > 0 && rows.length === 0) return fail('layout_changed', searchUrl, `${total} results but no rows read`);

    const target = core(keyword);
    const matches = rows.filter((r) => core(r.name) === target);

    if (matches.length === 0) {
      if (total > rows.length) {
        return fail('other', searchUrl,
          `search has ${total} results, only the first ${rows.length} are on the page; exact name not among them`);
      }
      return {
        status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `${total} result(s) for "${q}", none with the name "${keyword}"`,
      };
    }

    const records = [];
    for (let i = 0; i < matches.length; i++) {
      const row = matches[i];
      const rec = {
        name: row.name,
        suburb: row.suburb,
        town_city: row.town,
        status: row.status,
        register_url: row.href,
      };
      if (i < MAX_DETAILS && Date.now() - started < DETAIL_BUDGET_MS) {
        try {
          const d = await get(row.href);
          if (!d.ok) {
            rec.detail_error = `HTTP ${d.status}`;
          } else {
            const dh = await d.text();
            if (looksBlocked(dh)) {
              rec.detail_error = 'blocked';
            } else {
              const f = parseDetail(dh);
              if (!f['Licence number'] && !f['Name']) {
                rec.detail_error = 'layout_changed';
              } else {
                rec.name = f['Name'] || row.name;
                rec.licence_number = f['Licence number'] || '';
                rec.licence_type = f['Licence type'] || '';
                rec.licence_class = f['Licence class'] || '';
                rec.status = f['Current status'] || row.status;
                rec.trading_names = f['Trading name/s'] || '';
                rec.franchise_group = f['Franchise group'] || '';
                rec.business_address = f['Business address'] || '';
                rec.registered_office_address = f['Registered office address'] || '';
                rec.date_first_registered = f['Date first entered in register'] || '';
                rec.licence_period = f['Current licence period'] || '';
                rec.expiry_date = f['Expiry date'] || '';
                rec.work_types = f['Type of Real Estate work'] || '';
              }
            }
          }
        } catch (err) {
          const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
          rec.detail_error = timedOut ? 'timeout' : String(err?.message || err).slice(0, 120);
        }
      } else {
        rec.detail_error = 'not read: time or match limit';
      }
      records.push(rec);
    }

    const first = records[0];
    const excerpt = `${first.name}: licence ${first.licence_number || 'n/a'}, status ${first.status}` +
      (first.town_city ? `, ${first.town_city}` : '');
    return {
      status: 'found',
      reason: '',
      records,
      source_url: matches[0].href,
      excerpt: excerpt.slice(0, 500),
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timedOut ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
