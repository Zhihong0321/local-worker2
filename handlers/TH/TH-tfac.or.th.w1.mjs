export const meta = {
  task: 'TH-tfac.or.th',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_no', 'company_type', 'sign_year', 'auditors'],
  canary: { found: 'บจ.ปูนซีเมนต์ ตราลูกโลก จำกัด', not_found: 'บริษัท ทดสอบไม่มีจริง จำกัด' },
};

// TFAC's company-audit lookup (info.tfac.or.th/status/corporate) is a JSON API behind a Next.js page.
// Name search: GET /api/corporate/suggest?keyword=...&sign_year=YYYY (sign_year is required for a name).
// Auditors of one company: GET /api/corporate/{registrationNo}/check?sign_year=YYYY.
const API = 'https://info.tfac.or.th/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEARS = [2026, 2025, 2024, 2023];
const RETRY_WHILE_UNDER_MS = 4000; // only re-ask empty or failed years while the lookup is still quick

// Legal-form words, Thai and English, as the site and users write them.
const LEGAL_FORM = /บจก\.?|บมจ\.?|บจ\.?|\(มหาชน\)|มหาชน|บริษัท|จำกัด|จก\.?|company\s+limited|co\.?\s*,?\s*ltd\.?|public\s+company|limited|ltd\.?|pcl|plc/gi;

function stripLegalForm(s) {
  return (s || '').normalize('NFC').replace(LEGAL_FORM, ' ').replace(/\s+/g, ' ').trim();
}

/** Comparison key: no legal form, no spaces or punctuation, lower case. */
function core(s) {
  return stripLegalForm(s).toLowerCase().replace(/[^฀-๿a-z0-9]/g, '');
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://info.tfac.or.th/status/corporate',
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (res.status === 403 || res.status === 429) return { fail: 'blocked', detail: `HTTP ${res.status}` };
  if (!res.ok) return { fail: 'http_error', detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { fail: /captcha|cloudflare|challenge/i.test(text) ? 'blocked' : 'layout_changed', detail: text.slice(0, 200) };
  }
  if (!json || typeof json !== 'object') return { fail: 'layout_changed', detail: text.slice(0, 200) };
  return { json };
}

async function suggestYear(searchText, year) {
  const url = `${API}/corporate/suggest?keyword=${encodeURIComponent(searchText)}&limit=50&sign_year=${year}`;
  const r = await getJson(url);
  if (r.fail) return { year, url, fail: r.fail, detail: r.detail, rows: [] };
  if (!Array.isArray(r.json.data)) return { year, url, fail: 'layout_changed', detail: JSON.stringify(r.json).slice(0, 200), rows: [] };
  return { year, url, rows: r.json.data };
}

async function auditorsOf(registrationNo, year) {
  const url = `${API}/corporate/${encodeURIComponent(registrationNo)}/check?sign_year=${year}`;
  const r = await getJson(url);
  if (r.fail) return { url, fail: r.fail, detail: r.detail, auditors: null };
  if (!Array.isArray(r.json.data)) return { url, fail: 'layout_changed', detail: JSON.stringify(r.json).slice(0, 200), auditors: null };
  const auditors = r.json.data.map((a) => ({
    cpa_no: a.cpaNo ?? '',
    name_th: [a.titleTh, a.firstNameTh, a.lastNameTh].filter(Boolean).join(' '),
    name_en: [a.titleEn, a.firstNameEn, a.lastNameEn].filter(Boolean).join(' '),
    fiscal_year_end: a.fiscalYearEndDate ?? '',
    submit_date: a.submitDate ?? '',
    sign_date: a.signDate ?? '',
    confirm_date: a.confirmDate ?? '',
  }));
  return { url, auditors, companyType: r.json.data[0]?.corporate?.typeName ?? '' };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const searchText = stripLegalForm(keyword);
  const want = core(keyword);
  const sourceUrl = `${API}/corporate/suggest?keyword=${encodeURIComponent(searchText)}&limit=50&sign_year=${YEARS[0]}`;
  try {
    if (!want) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: sourceUrl, excerpt: 'no name left after removing the legal form' };
    }

    const hasHit = (rs) => rs.some((r) => r.rows.some((row) => row && typeof row.companyName === 'string' && core(row.companyName) === want));

    let rounds = await Promise.all(YEARS.map((y) => suggestYear(searchText, y)));
    // The site has answered 200 with an empty list for several seconds when the same query worked a moment later.
    // Before believing an empty or failed year, ask it again (at most 3 rounds, and only while the first ones were quick).
    let attempts = 1;
    while (attempts < 3 && Date.now() - started <= RETRY_WHILE_UNDER_MS && !hasHit(rounds) && rounds.some((r) => r.fail || r.rows.length === 0)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      rounds = await Promise.all(rounds.map((r) => (r.fail || r.rows.length === 0 ? suggestYear(searchText, r.year) : r)));
      attempts++;
    }

    const failed = rounds.filter((r) => r.fail);
    const hits = new Map(); // registrationNo -> { name, years: Set }
    const near = [];
    for (const r of rounds) {
      for (const row of r.rows) {
        if (!row || typeof row.companyName !== 'string' || !row.registrationNo) continue;
        if (core(row.companyName) === want) {
          if (!hits.has(row.registrationNo)) hits.set(row.registrationNo, { name: row.companyName, years: new Set() });
          hits.get(row.registrationNo).years.add(Number(row.signYear) || r.year);
        } else if (near.length < 5) {
          near.push(row.companyName);
        }
      }
    }

    if (hits.size === 0) {
      // A refused or broken answer for any year is never "not on the site".
      if (failed.length > 0) {
        const f = failed[0];
        return { status: 'couldnt_check', reason: f.fail, records: [], source_url: f.url, excerpt: `${f.year}: ${f.detail}`.slice(0, 500) };
      }
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: sourceUrl,
        excerpt: `No listing matches "${keyword}" for sign years ${YEARS.join(', ')} (${attempts} round(s) of asking).${near.length ? ' Similar names: ' + near.join('; ') : ''}`.slice(0, 500),
      };
    }

    // Ask for the auditors of each matched company, for each year it was listed.
    const jobs = [];
    for (const [registrationNo, hit] of hits) {
      for (const year of hit.years) jobs.push({ registrationNo, hit, year });
    }
    const checks = await Promise.all(jobs.map((j) => auditorsOf(j.registrationNo, j.year)));

    const records = jobs.map((j, i) => {
      const c = checks[i];
      return {
        name: j.hit.name,
        registration_no: j.registrationNo,
        company_type: c.companyType ?? '',
        sign_year: j.year,
        auditors: c.fail ? null : c.auditors,
        ...(c.fail ? { auditors_error: c.fail } : {}),
      };
    });

    return {
      status: 'found',
      reason: '',
      records,
      source_url: sourceUrl,
      excerpt: records.map((r) => `${r.name} (${r.registration_no}, sign year ${r.sign_year}): ${r.auditors ? r.auditors.length + ' auditor record(s)' : 'auditors not read'}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: sourceUrl,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
