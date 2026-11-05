export const meta = {
  task: 'MY-myhijau.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name',
  fields: [
    'name',
    'listing_no',
    'item_name',
    'certificate_no',
    'status',
    'certified_date',
    'expiry_date',
    'verification_body',
    'certificate_scheme',
  ],
  canary: { found: 'CAMFIL MALAYSIA', not_found: 'Dezeno' },
};

const BASE = 'https://www.myhijau.my';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-MY,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: BASE + '/directory/category',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polite crawl: at most ~1 request a second against the site.
let lastHit = 0;
async function pace() {
  const wait = lastHit + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit = Date.now();
}

async function httpGet(url, wantJson) {
  await pace();
  let res;
  try {
    res = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const to = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: to ? 'timeout' : 'http_error', detail: String((e && e.message) || e) };
  }
  let body = '';
  try {
    body = await res.text();
  } catch (e) {
    return { ok: false, reason: 'http_error', detail: 'body read failed' };
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const challenge = /just a moment\.\.\.|cf-browser-verification|checking your browser|_cf_chl_opt|attention required|access denied/i;
  if (
    res.status === 403 ||
    res.status === 429 ||
    res.status === 503 ||
    (body.length < 20000 && challenge.test(body))
  ) {
    return { ok: false, reason: 'blocked', status: res.status, detail: 'bot check / challenge or rate limit page' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http_error', status: res.status, body };
  }
  if (!wantJson) return { ok: true, status: res.status, body, contentType: ct };
  if (!/json/i.test(ct)) {
    return { ok: false, reason: 'layout_changed', status: res.status, body, detail: 'expected JSON, got ' + ct };
  }
  try {
    return { ok: true, status: res.status, json: JSON.parse(body), body };
  } catch (e) {
    return { ok: false, reason: 'layout_changed', status: res.status, body, detail: 'JSON parse failed' };
  }
}

function norm(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE = new Set(['SDN', 'BHD', 'BERHAD', 'SB', 'PLT', 'ENTERPRISE', 'AND', 'THE', 'M', 'MALAYSIA', 'MY']);

function nameMatches(keyword, company) {
  const k = norm(keyword);
  const c = norm(company);
  if (!k || !c) return false;
  if ((' ' + c + ' ').includes(' ' + k + ' ')) return true;
  const kt = k.split(' ').filter((t) => t.length > 1 && !NOISE.has(t));
  if (!kt.length) return false;
  const ct = new Set(c.split(' '));
  return kt.every((t) => ct.has(t));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
}

function htmlToLines(html) {
  const cleaned = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const txt = decodeEntities(cleaned.replace(/<[^>]+>/g, '\n'));
  return txt
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

function pickAfter(lines, label) {
  const key = label.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().replace(/\s+/g, ' ').trim() === key) {
      const v = lines[i + 1];
      if (v && v.length < 400) return v;
    }
  }
  return '';
}

function collectProductGroups(json) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'product_group' && Number.isFinite(node.id)) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        out.push({ id: node.id, name: node.name || '' });
      }
    }
    for (const c of node.children || []) walk(c);
  };
  for (const cat of json.data || []) walk(cat);
  return out;
}

export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  const catUrl =
    BASE +
    '/directory/category?page=1&limit=12&sort=asc&search_name=' +
    encodeURIComponent(kw);
  if (!kw) {
    return { status: 'not_found', reason: '', records: [], source_url: catUrl, excerpt: '' };
  }

  try {
    // Step 1: which directory categories hold a company matching the name?
    // (the site's own directory search; plain GET, JSON behind the page)
    const cat = await httpGet(catUrl, true);
    if (!cat.ok) {
      return {
        status: 'couldnt_check',
        reason: cat.reason || 'http_error',
        records: [],
        source_url: catUrl,
        excerpt: String(cat.detail || cat.status || '').slice(0, 300),
      };
    }
    const cj = cat.json || {};
    if (!Array.isArray(cj.data) || cj.total === undefined || cj.total === null) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: catUrl,
        excerpt: 'directory search JSON without data/total',
      };
    }
    if (Number(cj.total) === 0 || cj.data.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: catUrl,
        excerpt: 'Directory search returned no category with a record for "' + kw + '" (total 0).',
      };
    }

    // Step 2: walk the product groups of the matching categories and confirm
    // the company with the per-group company list endpoint.
    const groups = collectProductGroups(cj);
    const catNames = (cj.data || []).map((c) => c.name).filter(Boolean);

    let scanned = 0;
    for (const g of groups) {
      scanned++;
      if (scanned > 120) {
        return {
          status: 'couldnt_check',
          reason: 'other',
          records: [],
          source_url: catUrl,
          excerpt: 'too many product groups to scan (' + groups.length + ')',
        };
      }
      const listUrl =
        BASE +
        '/directory/company/' +
        g.id +
        '?page=1&limit=12&sort=asc&search_name=' +
        encodeURIComponent(kw);
      const list = await httpGet(listUrl, true);
      if (!list.ok) {
        return {
          status: 'couldnt_check',
          reason: list.reason || 'http_error',
          records: [],
          source_url: listUrl,
          excerpt: String(list.detail || list.status || '').slice(0, 300),
        };
      }
      const lj = list.json || {};
      if (!Array.isArray(lj.data) || lj.total === undefined || lj.total === null) {
        return {
          status: 'couldnt_check',
          reason: 'layout_changed',
          records: [],
          source_url: listUrl,
          excerpt: 'company list JSON without data/total',
        };
      }
      const hit = (lj.data || []).find((c) => nameMatches(kw, c.company_name));
      if (!hit) continue;

      // Step 3: the company's listings (listing no / certificate / dates).
      const coId = hit.id;
      const prodUrl =
        BASE +
        '/directory/product/' +
        g.id +
        '/' +
        coId +
        '?page=1&limit=12&sort=asc';
      const prod = await httpGet(prodUrl, true);
      const records = [];
      let items = [];
      if (prod.ok && prod.json && Array.isArray(prod.json.data)) {
        items = prod.json.data;
      }
      const certification = {
        compliance_category: '',
        certificate_scheme: '',
        verification_body: '',
        issuing_country: '',
      };
      // Step 4: the listing page (server-rendered) carries the certificate
      // scheme, compliance category and the verification body.
      let excerpt = '';
      const firstItem = items[0];
      if (firstItem && firstItem.id != null) {
        const itemUrl = prodUrl + '#' + firstItem.id;
        const detailUrl =
          BASE + '/directory/product/' + g.id + '/' + coId + '/' + firstItem.id;
        const det = await httpGet(detailUrl, false);
        if (det.ok) {
          const lines = htmlToLines(det.body);
          certification.compliance_category = pickAfter(lines, 'Compliance Category');
          certification.certificate_scheme = pickAfter(lines, 'Certificate Scheme');
          certification.verification_body = pickAfter(lines, 'Verification Body');
          certification.issuing_country = pickAfter(lines, 'Issuing Country');
          const i = lines.findIndex((l) => l.toLowerCase() === 'verification body');
          if (i > 0) {
            excerpt = lines.slice(Math.max(0, i - 6), i + 4).join(' | ').slice(0, 500);
          }
          void itemUrl;
        }
      }

      const max = Math.min(items.length, 5);
      for (let i = 0; i < max; i++) {
        const it = items[i] || {};
        const app = it.application || {};
        records.push({
          name: hit.company_name,
          listing_no: it.item_no || app.listing_number || '',
          item_name: it.name || '',
          certificate_no: app.certificate_no || '',
          status: app.status || '',
          certified_date: app.myhijau_cert_date || '',
          expiry_date: app.myhijau_exp_date || '',
          verification_body: i === 0 ? certification.verification_body : '',
          certificate_scheme: i === 0 ? certification.certificate_scheme : '',
        });
      }
      if (!records.length) {
        // Company is listed but the item list did not load: still a record.
        records.push({
          name: hit.company_name,
          listing_no: '',
          item_name: '',
          certificate_no: '',
          status: '',
          certified_date: '',
          expiry_date: '',
          verification_body: certification.verification_body,
          certificate_scheme: certification.certificate_scheme,
        });
      }
      if (!excerpt) {
        excerpt =
          hit.company_name +
          ' | ' +
          (g.name || '') +
          ' | ' +
          (catNames.join(', ') || '') +
          ' | listings: ' +
          items.length;
      }
      return {
        status: 'found',
        reason: '',
        records,
        source_url: prodUrl,
        excerpt: excerpt.slice(0, 500),
      };
    }

    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: catUrl,
      excerpt:
        'Searched ' +
        groups.length +
        ' product group(s) in ' +
        (catNames.join(', ') || 'matched categories') +
        ': no company named "' +
        kw +
        '".',
    };
  } catch (e) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: catUrl,
      excerpt: String((e && e.message) || e).slice(0, 300),
    };
  }
}
