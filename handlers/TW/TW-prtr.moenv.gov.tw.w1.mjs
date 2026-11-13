export const meta = {
  task: 'TW-prtr.moenv.gov.tw',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  pdf: false,
  input: 'company name',
  fields: ['name', 'registration_no', 'address', 'industry_park', 'industry', 'air', 'water', 'waste', 'toxic', 'penalty'],
  canary: { found: '中國石油化學工業開發股份有限公司', not_found: '不存在股份有限公司測試甲乙丙' },
};

const API = 'https://prtr.moenv.gov.tw/api/v1/Factory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Compare-friendly form: NFKC, lower case, 臺 -> 台, (股) -> 股份, no spaces or punctuation. */
function fold(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/臺/g, '台')
    .replace(/\(股\)/g, '股份')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** Folded name without its legal form (股份有限公司, 有限公司, 公司). */
function core(folded) {
  return folded.replace(/(股份有限公司|股份有限|有限公司|公司)$/, '');
}

/**
 * The site lists a facility under its owner's name, and contractor records as
 * "CONTRACTOR-OWNER project". So only the part before the first hyphen is the owner.
 * Same company: equal names, equal names without the legal form, or a plant of the
 * same legal entity (keyword is a full legal name and the owner starts with it).
 */
function isSameCompany(facilityName, keyword) {
  const owner = fold(String(facilityName || '').split(/[-－–—]/)[0]);
  const kw = fold(keyword);
  if (!owner || !kw) return false;
  if (owner === kw) return true;
  if (core(kw) && core(owner) === core(kw)) return true;
  if (/(股份有限公司|有限公司|公司)$/.test(kw) && owner.startsWith(kw)) return true;
  return false;
}

function fail(status, reason, source_url, excerpt) {
  return { status, reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').trim();
  const searchUrl = `${API}?Keyword=${encodeURIComponent(kw)}&Column=FacilityName&PollutionType=WAT%2CWAS%2CTOX%2CAIR&PageNumber=1&PageSize=0`;
  if (!kw) return fail('couldnt_check', 'other', searchUrl, 'empty keyword');

  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', searchUrl, `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', searchUrl, `HTTP ${res.status}`);

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/challenge|turnstile|captcha|cf-chl/i.test(text)) return fail('couldnt_check', 'blocked', searchUrl, text.slice(0, 200));
      return fail('couldnt_check', 'layout_changed', searchUrl, text.slice(0, 200));
    }

    if (json && json.Error) return fail('couldnt_check', 'other', searchUrl, `site error: ${JSON.stringify(json.Error)}`);
    if (!json || !json.Result || !Array.isArray(json.Result.Data)) {
      return fail('couldnt_check', 'layout_changed', searchUrl, text.slice(0, 200));
    }

    const rows = json.Result.Data;
    const matches = rows.filter((d) => isSameCompany(d.FacilityName, kw));

    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: searchUrl,
        excerpt: `${rows.length} facility names contain "${kw}"; none is this company`,
      };
    }

    const records = matches.map((d) => ({
      name: d.FacilityName,
      registration_no: d.RegistrationNo,
      address: d.FacilityAddress,
      industry_park: d.IndustryAreaName,
      industry: d.IndustryName,
      air: d.IsAir,
      water: d.IsWater,
      waste: d.IsWaste,
      toxic: d.IsToxic,
      penalty: d.IsPenalty,
    }));

    const first = records[0];
    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: `${records.length} record(s): ${first.registration_no} ${first.name} | ${first.address}`.slice(0, 500),
    };
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail('couldnt_check', timeout ? 'timeout' : 'other', searchUrl, String(err?.message || err));
  }
}
