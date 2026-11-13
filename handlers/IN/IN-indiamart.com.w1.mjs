export const meta = {
  task: 'IN-indiamart.com',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'company_id', 'url', 'badges', 'business_type', 'est_year', 'exporting_since', 'rating', 'reviews'],
  canary: { found: 'Siddhi Rubber India Private Limited', not_found: 'कृष्णा अनटेस्टेबल प्राइवेट लिमिटेड' },
};

const ORIGIN = 'https://export.indiamart.com';
const SEARCH = `${ORIGIN}/search.php?ss=`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
// Legal-form words dropped before comparing names ("Pvt." and "Private" are the same for matching).
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'opc', 'inc', 'incorporated', 'co', 'corp',
  'corporation', 'company', 'sdn', 'bhd', 'berhad', 'pte', 'plc', 'gmbh']);
const BADGES = ['Verified Exporter', 'Verified Manufacturer', 'Verified Supplier', 'TrustSEAL', 'GST Verified', 'IEC Verified'];
const BUSINESS_TYPE = /Business Type:\s*((?:Manufacturer|Wholesaler|Exporter|Trader|Retailer|Importer|Distributor|Service Provider|Supplier)(?:\s*(?:&|and)\s*(?:Manufacturer|Wholesaler|Exporter|Trader|Retailer|Importer|Distributor|Supplier))?)/i;

function decode(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decode((html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Normalised form used only for comparing names: lower case, no punctuation, no legal form, no spaces.
function norm(s) {
  return (s || '').normalize('NFKC').toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w && !LEGAL.has(w)).join('');
}

// Supplier cards on the results page: each card starts at its /company/ name link.
function parseCompanies(html) {
  const links = [];
  const linkRe = /<a\b[^>]*?href="(\/company\/[^"?#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    links.push({ key: m[1], pos: m.index, name: cleanText(m[2]) });
  }
  const seen = new Set();
  const companies = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (!l.name || seen.has(l.key)) continue;
    seen.add(l.key);
    // The card runs until the next supplier link with a different key (capped).
    const next = links.slice(i + 1).find((x) => x.key !== l.key);
    const end = Math.min(next ? next.pos : html.length, l.pos + 4000);
    const text = cleanText(html.slice(l.pos, end));
    const rating = text.match(/(\d\.\d)\s*\(\s*(\d[\d,]*)\s*Reviews?\s*\)/);
    const bt = text.match(BUSINESS_TYPE);
    const est = text.match(/Est\. Year:\s*(\d{4})/);
    const since = text.match(/Exporting Since:\s*(\d+\+?\s*yrs?)/i);
    companies.push({
      name: l.name,
      key: l.key,
      text,
      badges: BADGES.filter((b) => text.includes(b)),
      business_type: bt ? bt[1].replace(/\s+/g, ' ').trim() : null,
      est_year: est ? Number(est[1]) : null,
      exporting_since: since ? since[1] : null,
      rating: rating ? Number(rating[1]) : null,
      reviews: rating ? Number(rating[2].replace(/,/g, '')) : null,
    });
  }
  return companies;
}

const out = (status, reason, records, source_url, excerpt) => ({ status, reason, records, source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Windows Node can abort on exit while the keep-alive socket of the last fetch is still closing.
  // A short pause lets it close first; the whole call stays far under 60 s.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return answer;
}

async function search(keyword) {
  const kw = String(keyword ?? '').trim();
  const searchUrl = SEARCH + encodeURIComponent(kw);
  try {
    const want = norm(kw);
    if (!want) return out('couldnt_check', 'other', [], searchUrl, 'the company name has no letters or digits');

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': ACCEPT },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return out('couldnt_check', 'blocked', [], searchUrl, `HTTP ${res.status}`);
    }
    if (!res.ok) {
      return out('couldnt_check', 'http_error', [], searchUrl, `HTTP ${res.status}`);
    }

    const html = await res.text();
    const normalPage = /Indiamart Export|Search products or suppliers/i.test(html);
    if (!normalPage) {
      if (/captcha|verify you are human|are you a robot|unusual traffic|access denied|cf-chl/i.test(html)) {
        return out('couldnt_check', 'blocked', [], searchUrl, 'bot check or captcha page');
      }
      return out('couldnt_check', 'layout_changed', [], searchUrl, html.slice(0, 300));
    }

    const companies = parseCompanies(html);
    if (companies.length === 0) {
      // Supplier links exist in the page but none were read: the layout changed, do not call it not_found.
      if (/\/company\//.test(html)) {
        return out('couldnt_check', 'layout_changed', [], searchUrl, 'supplier links present but none parsed');
      }
      return out('not_found', '', [], searchUrl, `0 suppliers listed for "${kw}"`);
    }

    const matches = companies.filter((c) => norm(c.name) === want);
    if (matches.length === 0) {
      return out('not_found', '', [], searchUrl,
        `${companies.length} suppliers on the results page, none named "${kw}"`);
    }

    const records = matches.map((c) => ({
      name: c.name,
      company_id: c.key.replace(/^\/company\//, '').replace(/\/$/, ''),
      url: ORIGIN + c.key,
      badges: c.badges,
      business_type: c.business_type,
      est_year: c.est_year,
      exporting_since: c.exporting_since,
      rating: c.rating,
      reviews: c.reviews,
    }));
    return out('found', '', records, searchUrl, matches[0].text.slice(0, 500));
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], searchUrl, String(err?.message || err).slice(0, 300));
  }
}
