export const meta = {
  task: 'DE-bstbk.de',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'business_type', 'legal_form', 'address', 'phone', 'email', 'safe_id', 'recognition_date', 'chamber', 'detail_url', 'detail_status'],
  canary: { found: 'ECOVIS ACTA GmbH', not_found: 'Zwölfte Phantasie Steuerkanzlei XQ GmbH' },
};

const BASE = 'https://steuerberaterverzeichnis.berufs-org.de/';
const SEARCH_URL = BASE + '?lang=de';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9' };

// Legal-form words, removed before comparing names (both sides), so "ECOVIS ACTA GmbH & Co. KG" equals "ECOVIS ACTA GmbH".
// Also the business-type words the site prints under the name (e.g. "Steuerberater PartG mbB").
const LEGAL = new Set(['gmbh', 'ag', 'kg', 'ohg', 'gbr', 'mbh', 'mbb', 'partg', 'partgmbb', 'eg', 'ev', 'ug', 'se', 'co', 'kgaa', 'und',
  'steuerberater', 'steuerberatungsgesellschaft']);

function translit(s) {
  return (s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function coreTokens(s) {
  return translit(s).split(/[^a-z0-9]+/).filter((t) => t && !LEGAL.has(t));
}
function coreKey(s) { return coreTokens(s).join(''); }
// The search text as typed, minus the legal-form words (the site matches on the name, not the form).
function coreQuery(s) {
  const q = String(s).split(/[\s&.,]+/).filter((w) => w && !LEGAL.has(translit(w).replace(/[^a-z0-9]/g, ''))).join(' ');
  return q || String(s).trim();
}

function cleanText(html) {
  return (html || '').replace(/­/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}
function brLines(html) {
  return (html || '').split(/<br\s*\/?>/i).map(cleanText).filter(Boolean);
}
function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function readDetail(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return { error: 'blocked: HTTP ' + res.status };
    if (!res.ok) return { error: 'http_error: HTTP ' + res.status };
    const h = await res.text();
    if (!/id="firmenname"/.test(h)) return { error: 'layout_changed: no company block' };
    const f = (re) => { const m = h.match(re); return m ? cleanText(m[1]) : ''; };
    const addr = h.match(/<p id="adresse">([\s\S]*?)<\/p>/i);
    // Chamber: the two <p> blocks right under its heading (the next section is the shareholder list).
    const ch = h.match(/<h2 class="name">Zuständige Steuerberaterkammer<\/h2>[\s\S]{0,200}?<p>([\s\S]*?)<\/p>[\s\S]{0,200}?<p>([\s\S]*?)<\/p>/i);
    return {
      legal_form: f(/<p id="rechtsform">[\s\S]{0,300}?<span class="text-wrap">([\s\S]*?)<\/span>/i),
      address: addr ? brLines(addr[1]).join(', ') : '',
      phone: f(/<p id="telefon"[^>]*>[\s\S]{0,300}?<span class="text-wrap">([\s\S]*?)<\/span>/i),
      email: f(/<p id="email"[^>]*>[\s\S]{0,300}?<span class="text-wrap">([\s\S]*?)<\/span>/i),
      safe_id: f(/<p id="safeid">[\s\S]{0,300}?<span class="text-wrap">([\s\S]*?)<\/span>/i),
      recognition_date: f(/<span id="anerkennungsdatum-bag">[\s\S]{0,400}?<span class="text-wrap">([\s\S]*?)<\/span>/i),
      chamber: ch ? [cleanText(ch[1]), cleanText(ch[2])].filter(Boolean).join(', ') : '',
    };
  } catch (e) {
    return { error: (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'timeout' : 'other: ' + String(e && e.message || e).slice(0, 120) };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Windows Node asserts on exit if the process ends right after a fetch; let the sockets settle first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return fail('other', SEARCH_URL, 'empty keyword');
    const query = coreQuery(kw);

    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': SEARCH_URL },
      body: new URLSearchParams({ nachnameOrFirmenname: query, ortFilter: '', plzFilter: '' }).toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', SEARCH_URL, 'HTTP ' + res.status);
    if (!res.ok) return fail('http_error', SEARCH_URL, 'HTTP ' + res.status);
    const html = await res.text();

    // The site refuses to list a broad name: that is not an answer either way.
    if (/Zu viele m[öo]gliche Treffer/i.test(html)) {
      return fail('other', SEARCH_URL, `site: too many matches for "${query}" (refine the name); no result list shown`);
    }

    const rows = [];
    const cardRe = /<a class="link-to-detail" href="([^"]+)">[\s\S]*?<p class="name text-wrap">([\s\S]*?)<\/p>[\s\S]*?<p class="address-display text-wrap">([\s\S]*?)<\/p>/g;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      rows.push({ url: new URL(m[1], BASE).href, name: brLines(m[2]), address: brLines(m[3]).join(', ') });
    }

    if (rows.length === 0) {
      if (/keine Treffer|0 Treffer/i.test(html)) {
        return { status: 'not_found', reason: '', records: [], source_url: SEARCH_URL, excerpt: `site: 0 Treffer for "${query}"` };
      }
      return fail('layout_changed', SEARCH_URL, cleanText(html).slice(0, 300));
    }

    const wanted = coreKey(kw);
    const matches = rows.filter((r) => wanted && r.name.length
      && (coreKey(r.name[0]) === wanted || coreKey(r.name.join(' ')) === wanted));

    // "Treffer: N von M": if the site shows fewer rows than it found, a missing name is not proof of absence.
    const count = html.match(/Treffer:<\/strong>\s*(\d+)\s*von\s*(\d+)/i);
    const truncated = !!count && Number(count[1]) < Number(count[2]);

    if (matches.length === 0) {
      if (truncated) return fail('other', SEARCH_URL, `site shows ${rows.length} of ${count[2]} matches for "${query}"; "${kw}" not among them`);
      return {
        status: 'not_found', reason: '', records: [], source_url: SEARCH_URL,
        excerpt: `site returned ${rows.length} result(s) for "${query}", none named "${kw}"`,
      };
    }

    // Detail pages for up to 5 matches, read in parallel (keeps the call well under 60 s).
    const toRead = matches.slice(0, 5);
    const details = await Promise.all(toRead.map((r) => readDetail(r.url)));

    const records = matches.map((r, i) => {
      const d = details[i] || { error: 'not read (more than 5 matches)' };
      const ok = !d.error;
      return {
        name: r.name[0],
        business_type: r.name[1] || '',
        legal_form: ok ? d.legal_form : '',
        address: ok && d.address ? d.address : r.address,
        phone: ok ? d.phone : '',
        email: ok ? d.email : '',
        safe_id: ok ? d.safe_id : '',
        recognition_date: ok ? d.recognition_date : '',
        chamber: ok ? d.chamber : '',
        detail_url: r.url,
        detail_status: ok ? 'ok' : d.error,
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: records[0].detail_url,
      excerpt: `${matches.length} match(es) for "${kw}": ` + records.map((r) => `${r.name} | ${r.business_type} | ${r.address}`).join('; '),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(timeout ? 'timeout' : 'other', SEARCH_URL, String(err && err.message || err));
  }
}
