export const meta = {
  task: 'MY-sst01.customs.gov.my',
  want: 'w1',
  tier: 2,
  method: 'json_api',
  input: 'company name or SSM registration number (BRN)',
  fields: ['name', 'brn', 'sst_license_no', 'status', 'effective_date', 'address', 'phone'],
  canary: { found: 'YYC HOLDINGS SDN. BHD.', not_found: 'O2O DIGITAL SDN. BHD.' },
};

const API = 'https://sst02.customs.gov.my/api/services/app/LicenseRegistration/GetLicenseForInquiryWithoutEmail';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DELAY_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates(keyword) {
  const raw = String(keyword == null ? '' : keyword).replace(/\s+/g, ' ').trim().toUpperCase();
  if (!raw) return [];
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };

  push(raw);
  if (/^[0-9]{12}$/.test(raw) || /^[0-9]{6,7}-?[A-Z]$/.test(raw)) return out.slice(0, 1);

  // normalise the Malaysian legal-form spelling: the register stores "SDN. BHD."
  push(raw.replace(/\bSDN\s+BHD\b/g, 'SDN. BHD.'));
  // a bare brand name: try appending the usual legal forms
  if (!/\b(SDN|BHD|BERHAD|ENTERPRISE|PLT)\b/.test(raw)) {
    push(raw + ' SDN. BHD.');
    push(raw + ' SDN BHD');
    push(raw + ' BHD');
    push(raw + ' BERHAD');
  }
  return out.slice(0, 5);
}

function record(l) {
  const cancelled = l.isDeleted === true || (l.deletionTime && l.deletionTime !== null) ||
    (l.cancelStatusUserName && l.cancelStatusUserName !== null);
  return {
    name: l.companyName || l.tradeName || '',
    brn: l.brnNo || '',
    sst_license_no: l.sstLicenseNo || l.licenseNo || '',
    status: cancelled ? 'Deregistered' : 'Registered',
    effective_date: (l.effectiveDate || l.registeredDate || '').slice(0, 10),
    address: [l.companyAddress1, l.companyAddress2, l.companyAddress3].filter(Boolean).join(', '),
    phone: l.telephoneNo || '',
  };
}

function excerptOf(r) {
  const parts = [
    r.name, r.brn ? 'BRN ' + r.brn : '', r.sst_license_no ? 'SST ' + r.sst_license_no : '',
    r.status, r.effective_date ? 'effective ' + r.effective_date : '', r.address,
  ].filter(Boolean);
  return parts.join(' | ').slice(0, 500);
}

/** Look one company up. Never throws. */
export default async function lookup(keyword) {
  const cands = candidates(keyword);
  if (!cands.length) return { status: 'couldnt_check', reason: 'other', records: [], source_url: API, excerpt: 'empty keyword' };

  let lastUrl = '';
  let sawResponseShape = false;

  for (let i = 0; i < cands.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const url = API + '?input=' + encodeURIComponent(cands[i]);
    lastUrl = url;

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const name = e && e.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { status: 'couldnt_check', reason: 'timeout', records: [], source_url: url, excerpt: String(e && e.message || e) };
      }
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: String(e && e.message || e) };
    }

    if (res.status === 401 || res.status === 403) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: 'HTTP ' + res.status };
    }
    if (res.status !== 200) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: 'HTTP ' + res.status };
    }

    let j;
    try { j = await res.json(); } catch (e) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: 'non-JSON body' };
    }

    const body = JSON.stringify(j).slice(0, 400);
    if (j && j.success === false) {
      const msg = (j.error && j.error.message) || '';
      if (/recaptcha|captcha|verify/i.test(msg)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: msg.slice(0, 500) };
      }
      if (/login|authoriz/i.test(msg)) {
        return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: msg.slice(0, 500) };
      }
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: body };
    }

    // the endpoint we rely on must answer {success:true, result:{license:...}}
    if (!j || j.__abp !== true || !j.result || typeof j.result !== 'object' ||
        !Object.prototype.hasOwnProperty.call(j.result, 'license')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: body };
    }
    sawResponseShape = true;

    const l = j.result.license;
    if (l && (l.companyName || l.sstLicenseNo || l.brnNo)) {
      const r = record(l);
      return { status: 'found', reason: '', records: [r], source_url: url, excerpt: excerptOf(r) };
    }
  }

  if (!sawResponseShape) {
    return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: lastUrl, excerpt: 'unexpected response' };
  }
  return {
    status: 'not_found',
    reason: '',
    records: [],
    source_url: lastUrl,
    excerpt: 'No SST record for "' + String(keyword).slice(0, 120) + '" (tried: ' + cands.join(' / ') + ')',
  };
}
