export const meta = { task: 'CH-rab-asr.ch', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'rab_nr', 'uid', 'active', 'register_type', 'legal_form_other', 'street', 'post_code', 'city', 'country_id',
    'supervision', 'licences', 'other_licences', 'branches', 'memberships'],
  canary: { found: 'PricewaterhouseCoopers AG', not_found: 'Nichtexistierende Musterfirma Zzqxw AG' } };

// Public register of the Swiss audit oversight body (RAB/ASR), the Angular app at erab.rab-asr.ch.
// Search: POST JSON to internet/publicregister/search/{lang}; detail: GET internet/publicregister/detail-company/{id}/{lang}.
const BASE = 'https://erab.rab-asr.ch/backend/internet/publicregister';
const PAGE = 'https://erab.rab-asr.ch/#/publicregister';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_DETAILS = 5;
const DETAIL_CUTOFF_MS = 30000; // keep the whole call under 60 s
const LEGAL_FORMS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'kg', 'kmg', 'klg', 'genossenschaft', 'stiftung']);
const LEGAL_RE = /\b(AG|GmbH|SA|S[àa]rl|Sagl|Ltd|LLC|Inc|KG|KmG|KlG|Genossenschaft|Stiftung)\b\.?/gi;

function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

function tokens(str) {
  return clean(str).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Name without punctuation, case, diacritics or legal form, e.g. "Ernst & Young AG" -> "ernstandyoung". */
function coreKey(str) { return tokens(str).filter((t) => !LEGAL_FORMS.has(t)).join(''); }

function out(status, reason, records, excerpt) {
  return { status, reason, records, source_url: PAGE, excerpt: String(excerpt ?? '').slice(0, 500) };
}

/** Search the register. Returns { rows } or { fail, excerpt }. Throws only on network errors (caught by lookup). */
async function search(query) {
  const res = await fetch(`${BASE}/search/de`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullText: query, activeEntries: 'false', activeInCompany: 'both' }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 401 || res.status === 403 || res.status === 429) return { fail: 'blocked', excerpt: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', excerpt: `HTTP ${res.status}` };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!Array.isArray(data)) {
    return { fail: /captcha|challenge/i.test(text) ? 'blocked' : 'layout_changed', excerpt: text.slice(0, 300) };
  }
  if (data.length && !data.every((r) => r && typeof r.name === 'string' && r.id != null)) {
    return { fail: 'layout_changed', excerpt: JSON.stringify(data[0]).slice(0, 300) };
  }
  return { rows: data };
}

/** A search row is a company when it carries no first name (natural persons have one). */
const isCompany = (r) => r.firstName == null;

function baseRecord(r) {
  return { name: clean(r.name), rab_nr: clean(r.rabNr), register_id: r.id, active: r.active === true,
    register_type: clean(r.type), city: clean(r.place), post_code: clean(r.postCode) };
}

async function detail(r) {
  const b = baseRecord(r);
  try {
    const res = await fetch(`${BASE}/detail-company/${r.id}/de`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { ...b, detail: `unavailable: HTTP ${res.status}` };
    const d = await res.json();
    if (!d || typeof d !== 'object' || (!d.uidNr && !d.name)) return { ...b, detail: 'unavailable: unexpected layout' };
    return {
      ...b,
      name: clean(d.name) || b.name,
      uid: clean(d.uidNr),
      legal_form_other: clean(d.legalFormOther),
      street: clean(d.street),
      post_code: clean(d.postCode) || b.post_code,
      city: clean(d.city) || b.city,
      country_id: d.countryId ?? null,
      supervision: clean(d.externQS),
      licences: (d.zulassungen || []).map((z) => ({ type: z.type, date: z.date, state: z.state, crossed_out: z.durchgestrichen ?? null })),
      other_licences: (d.andereZulassungen || []).map((z) => ({ licence_type: z.licenseType, date: z.date, state: z.state, deletion_date: z.deletionDate ?? null })),
      branches: (d.zweigzulassungen || []).map((z) => ({ uid: clean(z.uid), name: clean(z.name), post_code: clean(z.postCode), place: clean(z.place) })),
      memberships: d.mitgliedschaften || [],
    };
  } catch (e) {
    return { ...b, detail: `unavailable: ${e?.name === 'TimeoutError' ? 'timeout' : 'error'}` };
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await run(keyword);
  // Node 24 on Windows aborts at process exit (exit 127, libuv "UV_HANDLE_CLOSING") when a keep-alive
  // socket from a second request to the same host is still closing. A short settle lets it finish first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function run(keyword) {
  const started = Date.now();
  try {
    const kw = clean(keyword);
    const wanted = coreKey(kw);
    if (!wanted) return out('couldnt_check', 'other', [], 'empty or unusable company name');

    // Full name first; if the register finds nothing with that exact name, retry without the legal form.
    const queries = [kw];
    const bare = clean(kw.replace(LEGAL_RE, ' '));
    if (bare && bare !== kw && bare.length >= 3) queries.push(bare);

    const matches = new Map();
    let hits = 0;
    for (const q of queries) {
      const s = await search(q);
      if (s.fail) return out('couldnt_check', s.fail, [], s.excerpt);
      hits += s.rows.length;
      for (const r of s.rows) {
        if (isCompany(r) && coreKey(r.name) === wanted && !matches.has(r.id)) matches.set(r.id, r);
      }
      if (matches.size) break;
    }

    if (matches.size === 0) {
      return out('not_found', '', [], `Public register search for "${kw}" returned ${hits} hit(s), none with this company name`);
    }

    const records = [];
    let i = 0;
    for (const r of matches.values()) {
      i++;
      if (i > MAX_DETAILS || Date.now() - started > DETAIL_CUTOFF_MS) {
        records.push({ ...baseRecord(r), detail: 'not fetched: time limit' });
      } else {
        records.push(await detail(r));
      }
    }

    const excerpt = `${records.length} match(es) in the public register: ` + records.map((r) =>
      `${r.name}, ${r.city || '-'} (RAB ${r.rab_nr}, ${r.active ? 'active' : 'inactive'})`).join('; ');
    return { status: 'found', reason: '', records, source_url: PAGE, excerpt: excerpt.slice(0, 500) };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'other';
    return out('couldnt_check', reason, [], String(err?.message || err));
  }
}
