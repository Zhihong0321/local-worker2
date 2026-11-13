export const meta = {
  task: 'AE-uaqchamber.ae',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_ar', 'registration_date', 'expiry_date', 'phone', 'mobile', 'fax', 'po_box', 'address', 'website', 'email', 'activity_en', 'activity_ar'],
  canary: { found: 'AL AHALI SUPERMARKET', not_found: 'شركة الخيال المستحيلة للتجارة ذ.م.م' },
};

// The E-Directory page (chamberhub.uaqchamber.online) calls this JSON endpoint on uaqchamber.com.
const API = 'http://uaqchamber.com/Counters.aspx?edirkeyword=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Legal-form words (lowercase, after normalising dots and spaces). Stripped only from the END of a name.
const LEGAL = new Set(['llc', 'fze', 'fzllc', 'fzco', 'ltd', 'limited', 'pjsc', 'psc', 'plc', 'spc', 'co', 'company',
  'sole', 'proprietorship', 'شذم', 'شمم', 'شمع', 'ششو', 'ذم']);

const out = (status, reason, records, source_url, excerpt) => ({ status, reason, records, source_url, excerpt });

function foldAr(s) {
  return s.replace(/[ً-ٟـ]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

/** Split a name into lowercase word tokens, with common legal-form abbreviations joined into one token. */
function tokens(raw) {
  const s = foldAr(String(raw || ''))
    .replace(/L\.\s*L\.\s*C\.?/gi, 'LLC')
    .replace(/ش\s*\.?\s*ذ\s*\.?\s*م\s*\.?\s*م\.?/g, 'شذم')
    .replace(/ش\s*\.?\s*م\s*\.?\s*م\.?/g, 'شمم')
    .replace(/ش\s*\.?\s*م\s*\.?\s*ع\.?/g, 'شمع')
    .replace(/ش\s*\.?\s*ش\s*\.?\s*و\.?/g, 'ششو')
    .replace(/ذ\s*\.?\s*م\s*\.?\s*م\.?/g, 'ذم');
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((t) => t.toLowerCase());
}

/** The name without its legal form, as tokens. */
function core(raw) {
  const t = tokens(raw);
  while (t.length && LEGAL.has(t[t.length - 1])) t.pop();
  return t;
}

/** The name as a search string (original spelling), with trailing legal-form words removed. */
function searchText(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const isLegal = (w) => { const t = tokens(w); return t.length > 0 && t.every((x) => LEGAL.has(x)); };
  while (words.length && isLegal(words[words.length - 1])) words.pop();
  return words.join(' ');
}

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

function dotnetDate(v) {
  const m = /\/Date\((-?\d+)\)\//.exec(String(v || ''));
  if (!m) return clean(v);
  const d = new Date(Number(m[1]));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function toRecord(r) {
  return {
    name: clean(r.TradeNameEn),
    name_ar: clean(r.TradeNameAr),
    registration_date: dotnetDate(r.Registration_Date),
    expiry_date: dotnetDate(r.Expiry_Date),
    phone: clean(r.Phone),
    mobile: clean(r.Mobile),
    fax: clean(r.Fax),
    po_box: clean(r.POBox),
    address: clean(r.Address),
    website: clean(r.Website),
    email: clean(r.Email),
    activity_en: clean(r.ActivityEn),
    activity_ar: clean(r.ActivityAr),
  };
}

/** One search request. Returns { url, rows } or { couldnt } when the site did not give a usable answer. */
async function runQuery(q) {
  const url = API + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { couldnt: out('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`) };
  if (!res.ok) return { couldnt: out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`) };
  const text = await res.text();
  if (/captcha|access denied|cloudflare/i.test(text.slice(0, 2000))) {
    return { couldnt: out('couldnt_check', 'blocked', [], url, text.slice(0, 200)) };
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  const shapeOk = Array.isArray(data) && data.every((r) => r && typeof r === 'object' && 'TradeNameEn' in r);
  if (!shapeOk) return { couldnt: out('couldnt_check', 'layout_changed', [], url, text.slice(0, 300)) };
  return { url, rows: data };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let lastUrl = '';
  try {
    const q1 = searchText(keyword);
    const key = core(keyword);
    if (!q1 || key.length === 0) return out('couldnt_check', 'other', [], '', 'no company name left to search after removing the legal form');
    const ck = key.join('');
    // Second try only when punctuation changes the query: the same words with punctuation removed (e.g. "AL-AHALI").
    const plain = q1.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
    const queries = plain === q1.toLowerCase() ? [q1] : [q1, plain];

    for (const q of queries) {
      const r = await runQuery(q);
      if (r.couldnt) return r.couldnt;
      lastUrl = r.url;
      const matches = r.rows.filter((row) => {
        const en = core(row.TradeNameEn).join('');
        const ar = core(row.TradeNameAr).join('');
        return (en && en === ck) || (ar && ar === ck);
      });
      if (matches.length) {
        return out('found', '', matches.map(toRecord), r.url,
          `${matches.length} matching record(s) among ${r.rows.length} results for "${q}"`);
      }
    }
    return out('not_found', '', [], lastUrl, `0 matching records for "${keyword}" (search: "${queries[0]}")`);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timedOut ? 'timeout' : 'other', [], lastUrl || API, String(err && err.message || err).slice(0, 300));
  }
}
