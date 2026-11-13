export const meta = { task: 'GB-fensa.org.uk', want: 'w1', tier: 1, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'registration_number', 'address', 'phone', 'email', 'website', 'products_installed'],
  canary: { found: 'Ideal Glass Limited', not_found: 'Zqxvkw Nonexistent Ltd' } };

const BASE = 'https://www.fensa.org.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' };
const MAX_MATCHES = 5;

/** Remove trailing UK legal-form words ("Ltd", "Limited", "LLP", ...). The site writes "Limited" in full,
 *  and a search for "Ideal Glass Ltd" finds nothing, so the search uses the name without the legal form. */
function stripLegalForm(s) {
  let t = (s || '').trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/[\s,]+(ltd\.?|limited|llp|plc|lp|cic)\s*\.?$/i, '').trim();
  } while (t && t !== prev);
  return t || (s || '').trim();
}

/** Comparison key: legal form removed, case, punctuation, spaces and "&" vs "and" ignored. */
function nameKey(s) {
  return stripLegalForm(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
function decode(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m));
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** GET one page. Returns { res, html } or throws; the caller maps errors to reasons. */
async function getPage(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
  const html = res.status === 403 || res.status === 429 || !res.ok ? '' : await res.text();
  return { res, html };
}

function fetchErrorResult(err, url) {
  const name = err && err.name;
  if (name === 'TimeoutError' || name === 'AbortError') return couldnt('timeout', url, 'no answer within 25 s');
  return couldnt('other', url, String((err && err.message) || err));
}

/** Parse one installer detail page (/installers/<slug>). Returns a record or null when the layout is not as expected. */
function parseDetail(html, url) {
  const reg = html.match(/<p[^>]*>\s*Reg:\s*([^<]+?)\s*<\/p>/i);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!reg || !h1) return null;
  const address = html.match(/fa-map-marker[^"]*"><\/i>([^<]+)</i);
  const phone = html.match(/href="tel:([^"]+)"/i);
  const email = html.match(/href="mailto:([^"]+)"/i);
  const website = html.match(/fa-browser[^"]*"><\/i><a[^>]*href="([^"]+)"/i);
  const products = [];
  const pSection = html.match(/Products Installed[\s\S]*?<\/div>\s*<\/div>/i);
  if (pSection) {
    for (const b of pSection[0].match(/<button[^>]*>[\s\S]*?<\/button>/g) || []) products.push(cleanText(b));
  }
  return {
    name: cleanText(h1[1]),
    registration_number: cleanText(reg[1]),
    address: address ? cleanText(address[1]) : '',
    phone: phone ? decode(phone[1]).trim() : '',
    email: email ? decode(email[1]).trim() : '',
    website: website ? decode(website[1]).trim() : '',
    products_installed: products,
    source_url: url,
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const raw = String(keyword || '').trim();
    if (!raw) return couldnt('other', BASE + '/find-installers', 'empty company name');

    const term = stripLegalForm(raw);
    const searchUrl = `${BASE}/search-results?search=${encodeURIComponent(term)}`;

    // Step 1: name search (plain GET, public page)
    const s = await getPage(searchUrl);
    if (s.res.status === 403 || s.res.status === 429) return couldnt('blocked', searchUrl, `HTTP ${s.res.status}`);
    if (!s.res.ok) return couldnt('http_error', searchUrl, `HTTP ${s.res.status}`);

    const html = s.html;
    const isSearchPage = /<h1[^>]*>\s*Search:/i.test(html);
    if (!isSearchPage) {
      if (/challenge-platform|cf-chl|Attention Required|captcha/i.test(html)) {
        return couldnt('blocked', searchUrl, 'bot check page');
      }
      return couldnt('layout_changed', searchUrl, html.slice(0, 300));
    }

    // Result links: <a class="underline" href="https://www.fensa.org.uk/installers/<slug>">Name</a>
    const links = [];
    const seen = new Set();
    const linkRe = /<a[^>]*href="(https?:\/\/www\.fensa\.org\.uk\/installers\/[^"#?]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href = decode(m[1]).trim();
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({ href, name: cleanText(m[2]) });
    }

    const wanted = nameKey(raw);
    const matches = links.filter((l) => nameKey(l.name) === wanted);

    if (matches.length === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl,
        excerpt: `FENSA search "${term}": ${links.length} installer name(s) listed, none matches "${raw}"` };
    }

    // Step 2: detail page of each matching installer (in parallel, capped)
    const picked = matches.slice(0, MAX_MATCHES);
    const details = await Promise.all(picked.map(async (l) => {
      try {
        const d = await getPage(l.href);
        if (d.res.status === 403 || d.res.status === 429) return { fail: couldnt('blocked', l.href, `HTTP ${d.res.status}`) };
        if (!d.res.ok) return { fail: couldnt('http_error', l.href, `HTTP ${d.res.status}`) };
        const rec = parseDetail(d.html, l.href);
        if (!rec) return { fail: couldnt('layout_changed', l.href, cleanText(d.html).slice(0, 300)) };
        return { rec };
      } catch (err) {
        return { fail: fetchErrorResult(err, l.href) };
      }
    }));

    const failed = details.find((d) => d.fail);
    if (failed) return failed.fail;

    const records = details.map((d) => d.rec);
    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: first.source_url,
      excerpt: `Reg: ${first.registration_number}. ${first.name}. ${first.address}`.slice(0, 500),
    };
  } catch (err) {
    return fetchErrorResult(err, `${BASE}/find-installers`);
  }
}
