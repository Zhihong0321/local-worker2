// MY-st.gov.my — Suruhanjaya Tenaga (Energy Commission) Malaysia
// Want w1: is the company a registered electrical or gas contractor / licensee?
//
// Two public registers are searched, both plain HTTP (no JS, no login):
//  1) Electrical contractors  — ecos.st.gov.my, the GET ajax endpoint the
//     "Senarai Kontraktor Elektrik Berdaftar" page itself calls.
//  2) Gas contractors         — oas.st.gov.my, the POST endpoint behind the
//     "Senarai Kontraktor Gas" search form.
// Both are the site's own open endpoints (no session, no token needed).

export const meta = {
  task: 'MY-st.gov.my',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['name', 'register', 'type', 'class', 'roc', 'phone', 'email', 'start', 'expiry', 'city', 'state', 'competent_person'],
  canary: { found: 'GAMUDA M&E SDN BHD', not_found: 'O2O Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;

const ECOS_PAGE = 'https://ecos.st.gov.my/ms/web/guest/senarai-kontraktor-elektrik-berdaftar';
const ECOS_AJAX = 'https://ecos.st.gov.my/ReportAdmin-portlet/html/reportcustom/ajax/getSenaraiKontraktorBerdaftar.jsp';
const OAS_PAGE = 'https://oas.st.gov.my/senarai-kontraktor-gas';
const OAS_AJAX = 'https://oas.st.gov.my/STOASPublicPortlet/dashboard/kontraktorinfo/searchKontraktor.oas';

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  return { status: res.status, body };
}

function cells(rowHtml) {
  const out = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(m[1]);
  return out;
}

function dataRows(html) {
  // every <tr> that actually carries <td> cells and is not the header row
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const c = cells(m[1]);
    if (c.length >= 3) rows.push(c);
  }
  return rows;
}

// ---------------------------------------------------------------- electrical
async function searchElectrical(keyword) {
  const qs = new URLSearchParams({
    path: ':home:ecosadmin:Kontraktor:LIST_PORTAL_KONTRAKTOR.prpt',
    uid: '2',
    pathajax: '/html/reportcustom/ajax/getSenaraiKontraktorBerdaftar.jsp',
    P_PEJABATST: '',
    P_KONTRAKTOR: '',
    P_SYARIKAT: keyword,
    P_SSM: '',
    P_NEGERI: '',
    P_NAMA: '',
    P_SIJIL: '',
  });
  const { status, body } = await fetchText(`${ECOS_AJAX}?${qs.toString()}`, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*' },
  });
  if (status !== 200) return { error: 'http_error', detail: `ecos HTTP ${status}` };
  // layout markers we depend on
  const hasTable = /id="tablerekod-result"/.test(body);
  const hasHeader = body.includes('Nama Syarikat') && body.includes('No.ROC');
  if (!hasTable || !hasHeader) return { error: 'layout_changed', detail: 'ecos result table/header missing' };
  if (/Tiada\s*Rekod/i.test(body)) return { records: [], text: 'Tiada Rekod' };

  const records = [];
  const seen = new Map();
  for (const c of dataRows(body)) {
    if (c.length < 13) continue;
    const name = clean(c[4]);
    if (!name) continue;
    // one row per competent person; fold them into a single company record
    const key = [name, clean(c[5]), clean(c[3]), clean(c[8]), clean(c[9])].join('|');
    const person = clean(c[12]);
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (person && !prev.competent_person.split('; ').includes(person)) {
        prev.competent_person = prev.competent_person ? `${prev.competent_person}; ${person}` : person;
      }
      continue;
    }
    const rec = {
      name,
      register: 'Suruhanjaya Tenaga — Senarai Kontraktor Elektrik Berdaftar',
      type: clean(c[2]),
      class: clean(c[3]),
      roc: clean(c[5]),
      phone: clean(c[6]),
      email: clean(c[7]),
      start: clean(c[8]),
      expiry: clean(c[9]),
      city: clean(c[10]),
      state: clean(c[11]),
      competent_person: person,
      office: clean(c[1]),
    };
    seen.set(key, rec);
    records.push(rec);
  }
  return { records, text: body };
}

// ----------------------------------------------------------------------- gas
async function searchGas(keyword) {
  const body = new URLSearchParams({
    status: 'A',
    outputType: '',
    nama: keyword,
    negeri: '',
    statusDaftar: '',
    kelas: '',
    tkhtamat_from: '',
    tkhtamat_to: '',
  });
  const { status, body: html } = await fetchText(`${OAS_AJAX}?${Date.now() % 997}`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      referer: OAS_PAGE,
      accept: 'text/html,*/*',
    },
    body: body.toString(),
  });
  if (status !== 200) return { error: 'http_error', detail: `oas HTTP ${status}` };
  if (!/class="app-list"/.test(html) || !/Jumlah\s*rekod/.test(html)) {
    return { error: 'layout_changed', detail: 'oas result table missing' };
  }
  const count = /Jumlah\s*rekod\s*:\s*<b>\s*(\d+)/i.exec(html);
  const records = [];
  for (const c of dataRows(html)) {
    if (c.length < 6) continue;
    const name = clean(c[1]);
    if (!name) continue;
    const addr = c[2];
    const phone = /Telefon\s*:\s*([^<\n]+)/i.exec(addr);
    const parts = (html2) =>
      String(html2)
        .split(/<br\s*\/?>/i)
        .map((l) => clean(l))
        .filter(Boolean);
    const addrLines = parts(addr).filter((l) => !/^Telefon/i.test(l) && !/^Faks/i.test(l));
    const people = parts(c[5]).filter((l) => l && !/^-+$/.test(l));
    records.push({
      name,
      register: 'Suruhanjaya Tenaga — Senarai Kontraktor Gas',
      type: 'KONTRAKTOR GAS',
      class: clean(c[3]),
      roc: '',
      phone: phone ? clean(phone[1]) : '',
      email: '',
      start: '',
      expiry: clean(c[4]),
      city: '',
      state: addrLines.length ? addrLines[addrLines.length - 1] : '',
      competent_person: people.join('; '),
      address: addrLines.join(', '),
    });
  }
  if (!records.length && count && Number(count[1]) > 0) {
    return { error: 'layout_changed', detail: 'oas reports records but no rows parsed' };
  }
  return { records, text: 'Jumlah rekod : ' + (count ? count[1] : '0') };
}

// -------------------------------------------------------------------- lookup
export default async function lookup(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: ECOS_PAGE, excerpt: 'empty keyword' };
  }

  const results = [];
  let hadError = null;

  try {
    results.push({ source: 'electrical', ...(await searchElectrical(kw)) });
  } catch (e) {
    hadError = hadError || { reason: 'timeout', detail: `ecos ${e && e.message}` };
    results.push({ source: 'electrical', error: 'timeout', detail: String(e && e.message) });
  }

  try {
    results.push({ source: 'gas', ...(await searchGas(kw)) });
  } catch (e) {
    hadError = hadError || { reason: 'timeout', detail: `oas ${e && e.message}` };
    results.push({ source: 'gas', error: 'timeout', detail: String(e && e.message) });
  }

  const records = [];
  for (const r of results) if (r.records && r.records.length) records.push(...r.records);

  if (records.length) {
    const r0 = records[0];
    const excerpt = (
      `${r0.name} — ${r0.type || ''} Kelas ${r0.class || '-'} — ROC ${r0.roc || '-'} — ` +
      `${r0.start || '-'} to ${r0.expiry || '-'} — ${r0.city || ''} ${r0.state || ''} — ` +
      `${r0.competent_person || ''} (${r0.register}); ${records.length} record(s) total`
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    const src = results.find((r) => r.records && r.records.length);
    return {
      status: 'found',
      reason: '',
      records,
      source_url: src && src.source === 'gas' ? OAS_PAGE : ECOS_PAGE,
      excerpt,
    };
  }

  const err = hadError || results.find((r) => r.error);
  if (err) {
    const reason = err.reason || (err.error === 'layout_changed' ? 'layout_changed' : err.error) || 'other';
    return {
      status: 'couldnt_check',
      reason,
      records: [],
      source_url: ECOS_PAGE,
      excerpt: String(err.detail || '').slice(0, 500),
    };
  }

  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: ECOS_PAGE,
    excerpt: `Searched both registers for "${kw}" — Tiada Rekod (electrical contractors) and Jumlah rekod 0 (gas contractors).`,
  };
}
