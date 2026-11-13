export const meta = { task: 'VN-amchamvietnam.com', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'description', 'website_url', 'company_size'],
  canary: { found: '3M Vietnam Ltd.', not_found: 'Công ty TNHH Thương Mại Dịch Vụ Hoàng Gia Minh Long' } };

// The member directory page (https://www.amchamvietnam.com/members/) is a single-page app. It reads its list from the
// site's backend with the public anon key that the site ships to every browser in its own JavaScript. This is that
// same public read, filtered to is_member = true (the rows the directory shows). Nothing is logged in or bypassed.
const SITE_PAGE = 'https://www.amchamvietnam.com/members/';
const API = 'https://pvfyblupzbxwvlqrpndg.supabase.co/rest/v1/companies_public';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2ZnlibHVwemJ4d3ZscXJwbmRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3ODU4MzIsImV4cCI6MjA5NDM2MTgzMn0.AoCG6KBC8-BQhWgTs3KPIBRoyj-5HU8lIPLezDt6z_s';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE = 1000;
const MAX_PAGES = 5;

// Legal-form and filler words, dropped on both sides before comparing.
const LEGAL = new Set(['co', 'company', 'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'jsc', 'plc',
  'pte', 'pvt', 'sdn', 'bhd', 'gmbh', 'tnhh', 'cong', 'ty', 'phan', 'join', 'stock']);

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !LEGAL.has(t))
    .join(' ');
}

// "Good Day Hospitality JSC (McDonald's Vietnam)" or "Hitachi ... Ltd. – Ho Chi Minh Branch" -> the part before the branch or brand note.
function base(s) {
  return String(s || '').split(/\s+[-–—]\s+|\s*\(/)[0];
}

function clean(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: SITE_PAGE, excerpt: String(excerpt).slice(0, 300) };
}

async function fetchMembers() {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${API}?select=id,name,description,website_url,company_size&is_member=eq.true&order=id.asc&limit=${PAGE}&offset=${page * PAGE}`;
    const res = await fetch(url, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Accept': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return { fail: fail('blocked', `HTTP ${res.status} from the directory data endpoint`) };
    if (!res.ok) return { fail: fail('http_error', `HTTP ${res.status} from the directory data endpoint`) };

    let data;
    try { data = await res.json(); } catch { return { fail: fail('layout_changed', 'directory data endpoint did not return JSON') }; }
    if (!Array.isArray(data) || data.some((r) => !r || typeof r.name !== 'string')) {
      return { fail: fail('layout_changed', 'directory data has an unexpected shape') };
    }
    rows.push(...data);
    if (data.length < PAGE) return { rows };
  }
  return { fail: fail('other', `directory has more than ${PAGE * MAX_PAGES} rows; stopped at the limit`) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    const kwVariants = new Set([norm(kw), norm(base(kw))].filter(Boolean));
    if (kwVariants.size === 0) return fail('other', 'the company name has no usable words after removing legal form');

    const got = await fetchMembers();
    // Let the HTTP sockets close before the runner exits (Node on Windows can assert on an immediate exit).
    await new Promise((r) => setTimeout(r, 300));
    if (got.fail) return got.fail;

    // The directory answered with an empty list: treat as a site change, never as "not listed".
    if (got.rows.length === 0) return fail('layout_changed', 'the directory returned zero members');

    const matches = got.rows.filter((r) => {
      const variants = [norm(r.name), norm(base(r.name))].filter(Boolean);
      return variants.some((v) => kwVariants.has(v));
    });

    if (matches.length === 0) {
      return {
        status: 'not_found', reason: '', records: [], source_url: SITE_PAGE,
        excerpt: `Not in the AmCham Vietnam member directory (${got.rows.length} members checked)`,
      };
    }

    const records = matches.map((r) => ({
      name: r.name,
      description: clean(r.description).slice(0, 300),
      website_url: r.website_url || '',
      company_size: r.company_size || '',
    }));

    return {
      status: 'found', reason: '', records, source_url: SITE_PAGE,
      excerpt: `Listed in the AmCham Vietnam member directory as: ${matches.map((r) => r.name).join('; ')}`.slice(0, 500),
    };
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', 'the directory data endpoint did not answer in 25 s');
    return fail('other', String((err && err.message) || err));
  }
}
