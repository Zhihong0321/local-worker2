export const meta = {
  task: 'SG-streetdirectory.com',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'category', 'address', 'phone', 'company_id', 'branch_id', 'detail_url'],
  canary: { found: 'Singapore Airlines Limited', not_found: 'Zqxvkwpl Holdings Pte Ltd' },
};

const SITE = 'https://www.streetdirectory.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Legal-form words dropped before comparing names (Singapore and Malaysian forms).
const LEGAL = new Set(['pte', 'ltd', 'limited', 'private', 'pvt', 'llp', 'llc', 'inc', 'corp', 'corporation', 'sdn', 'bhd', 'berhad']);
// No new request starts after 30 s, so with the 25 s per-fetch timeout the call ends before 60 s.
const STOP_MS = 30000;
const MAX_PAGES = 20;
const MAX_DETAIL = 5;
const BLOCK_RE = /captcha|are you a robot|verify you are human|cf-chl|access denied|unusual traffic/i;

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function clean(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ')
    .filter((t) => t && !LEGAL.has(t));
}

function key(s) {
  return tokens(s).join('');
}

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

function classify(err) {
  const n = err && err.name;
  return n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'other';
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const text = res.ok ? await res.text() : '';
  return { status: res.status, url: res.url || url, text };
}

// Two company-page link forms appear in results:
//   /businessfinder/company_detail.php?companyid=N&branchid=M   (search results list)
//   /asiatravel/singaporemap/business/N/M/                      (map-style results, e.g. page 2)
function idsOf(href) {
  const d = href.match(/companyid=(\d+).*?branchid=(\d+)/);
  if (d) return { company_id: d[1], branch_id: d[2] };
  const s = href.match(/\/singaporemap\/business\/(\d+)\/(\d+)/);
  if (s) return { company_id: s[1], branch_id: s[2] };
  return null;
}

/** Result rows: each company link is an <a class="item_title_search"> to a company page. */
function parseResults(html) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (!/class="item_title_search"/.test(attrs)) continue;
    const href = (attrs.match(/href="([^"]+)"/) || [])[1];
    const ids = href ? idsOf(decode(href)) : null;
    if (!ids) continue;
    anchors.push({ index: m.index, end: re.lastIndex, href: decode(href), ids, name: clean(m[2]) });
  }
  return anchors.map((a, i) => {
    const next = i + 1 < anchors.length ? anchors[i + 1].index : a.end + 1500;
    // The category line belongs to this row only: stop at the next row or the end of this table.
    const block = html.slice(a.end, next).split('</table>')[0].slice(0, 800);
    const cat = block.match(/Business dealing with <a[^>]*>([\s\S]*?)<\/a>/i);
    return {
      name: a.name,
      company_id: a.ids.company_id,
      branch_id: a.ids.branch_id,
      detail_url: new URL(a.href, SITE).href,
      category: cat ? clean(cat[1]) : '',
    };
  });
}

function maxPage(html) {
  const nums = [...html.matchAll(/title="Go To Page (\d+)"/g)].map((x) => Number(x[1]));
  return nums.length ? Math.max(...nums) : 1;
}

/** Company page: name, address and phone. Returns null when the page is not a company page. */
function parseDetail(html) {
  let name = '';
  let address = '';
  let phone = '';
  const nameM = html.match(/<div id="company_name"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
  if (nameM) {
    // businessfinder company page
    name = clean(nameM[1]);
    const addrM = html.match(/<div id="company_address"[^>]*>([\s\S]*?)<\/div>/i);
    address = addrM ? clean(addrM[1]) : '';
    if (name && address.toLowerCase().startsWith(name.toLowerCase())) address = address.slice(name.length);
    const telM = html.match(/<a[^>]*href="tel:[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    phone = telM ? clean(telM[1]) : '';
  } else {
    // singaporemap business page: name in "Reg. Name", address block by id; phone sits behind a "Call Now" click
    const reg = html.match(/<b>Reg\. Name:<\/b>\s*(?:<br\s*\/?>)?\s*([^<]+)/i);
    const title = html.match(/<title>([^<]*)<\/title>/i);
    name = reg ? clean(reg[1]) : (title ? clean(title[1]) : '');
    const i = html.indexOf('id="address_location_lhs"');
    if (i >= 0) {
      const seg = html.slice(i, i + 1500).split(/<div|Tel:/i)[0].replace(/^[^>]*>/, '');
      address = clean(seg);
    }
  }
  if (!name) return null;
  address = address.replace(/^[\s,]+|[\s,]+$/g, '');
  return { name, address, phone };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const typed = String(keyword || '').trim();
  const wanted = key(typed);
  if (!typed || !wanted) {
    return fail('other', SITE, 'keyword has no Latin letters or digits; this site search cannot be run on it');
  }

  try {
    // Query 1: the name as typed. Query 2 (only if different): the name without legal form.
    const queries = [typed];
    const core = tokens(typed).join(' ');
    if (core && core !== typed.toLowerCase()) queries.push(core);

    let searchUrl = '';
    let matches = [];
    let allItems = [];
    let validPages = 0;
    let budgetHit = false;
    let truncated = false;
    let emptyList = false;
    let noResultsText = '';

    queries: for (const q of queries) {
      let page = 1;
      let last = 1;
      do {
        if (elapsed() > STOP_MS) { budgetHit = true; break queries; }
        const qs = encodeURIComponent(q).replace(/%20/g, '+');
        const url = `${SITE}/asia_travel/search/?q=${qs}${page > 1 ? `&p=${page}` : ''}`;
        if (!searchUrl) searchUrl = url;

        const r = await fetchText(url);
        if (r.status === 403 || r.status === 429) return fail('blocked', url, `HTTP ${r.status}`);
        if (r.status !== 200) return fail('http_error', url, `HTTP ${r.status}`);

        // A search with exactly one hit is redirected straight to that company's page.
        if (/company_detail\.php|\/singaporemap\/business\/\d+\/\d+/.test(r.url)) {
          const d = parseDetail(r.text);
          if (!d) return fail('layout_changed', r.url, r.text.slice(0, 300));
          validPages++;
          allItems.push({ name: d.name, company_id: '', branch_id: '', detail_url: r.url, category: '' });
          if (key(d.name) === wanted) {
            matches = [{ name: d.name, company_id: '', branch_id: '', detail_url: r.url, category: '', address: d.address, phone: d.phone }];
          }
          break; // one record page means this query is finished
        }

        const trimmed = r.text.trim();
        if (trimmed === '[]') { emptyList = true; break; }

        const items = parseResults(r.text);
        const noResMatch = r.text.match(/Displaying 0 results[^<]{0,120}|found 0 results|No results for[^<]{0,120}/i);
        if (!items.length && !noResMatch) {
          if (BLOCK_RE.test(r.text)) return fail('blocked', url, 'captcha or bot-check page');
          return fail('layout_changed', url, r.text.slice(0, 300));
        }
        if (!items.length && noResMatch && !noResultsText) noResultsText = clean(noResMatch[0]);
        validPages++;
        allItems.push(...items);
        matches = items.filter((i) => key(i.name) === wanted);
        if (matches.length) break queries;

        last = maxPage(r.text);
        if (page >= MAX_PAGES && last > MAX_PAGES) truncated = true;
        page++;
      } while (page <= Math.min(last, MAX_PAGES));
    }

    if (matches.length) {
      // Add address and phone from each matched company page, as far as the time allows.
      const out = [];
      for (let i = 0; i < matches.length; i++) {
        const rec = matches[i];
        if (rec.address !== undefined) { out.push(rec); continue; }
        if (i >= MAX_DETAIL || elapsed() > STOP_MS) { out.push({ ...rec, address: '', phone: '', detail_error: 'not fetched: time limit' }); continue; }
        try {
          const dr = await fetchText(rec.detail_url);
          const d = dr.status === 200 ? parseDetail(dr.text) : null;
          out.push(d
            ? { ...rec, name: rec.name, address: d.address, phone: d.phone }
            : { ...rec, address: '', phone: '', detail_error: `detail HTTP ${dr.status}` });
        } catch (err) {
          out.push({ ...rec, address: '', phone: '', detail_error: `detail ${classify(err)}` });
        }
      }
      const first = out[0];
      const excerpt = [first.name, first.category, first.address, first.phone].filter(Boolean).join(' | ');
      return {
        status: 'found',
        reason: '',
        records: out.map(({ address, phone, name, category, company_id, branch_id, detail_url, detail_error }) => ({
          name, category, address, phone, company_id, branch_id, detail_url,
          ...(detail_error ? { detail_error } : {}),
        })),
        source_url: first.detail_url,
        excerpt,
      };
    }

    if (budgetHit) return fail('timeout', searchUrl, 'search pages did not finish within 30 s');
    if (validPages === 0 && emptyList) {
      return fail('other', searchUrl, 'site search returned an empty list ([]) instead of a results page; a real no-match cannot be told apart from an unsupported query');
    }
    if (validPages === 0) return fail('other', searchUrl, 'no usable search page');
    if (truncated) return fail('other', searchUrl, `search has more pages than the first ${MAX_PAGES} read; no exact name in them`);

    const names = allItems.slice(0, 3).map((i) => i.name).join('; ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: noResultsText
        ? noResultsText
        : `${allItems.length} site result(s), none with the same name after case, punctuation and legal form are removed${names ? ': ' + names : ''}`,
    };
  } catch (err) {
    return fail(classify(err), searchUrl_safe(keyword), String(err?.message || err));
  }
}

function searchUrl_safe(keyword) {
  return `${SITE}/asia_travel/search/?q=${encodeURIComponent(String(keyword || '')).replace(/%20/g, '+')}`;
}
