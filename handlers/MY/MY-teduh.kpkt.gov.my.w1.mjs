export const meta = { task: 'MY-teduh.kpkt.gov.my', want: 'w1', tier: 2, method: 'get', pdf: false, input: 'company name',
  fields: ['name', 'kod_pemaju', 'licence_no', 'licence_from', 'licence_to', 'registered_address', 'business_address',
    'projects_total', 'sick_projects', 'abandoned_projects', 'projects'],
  canary: { found: '168 PARK SELAYANG SDN. BHD.', not_found: 'SYARIKAT PEMAJU PERUMAHAN TIDAK WUJUD SDN BHD' } };

// TEDUH's licensed-developer list has a JSON search: /api/developer-swasta?q=<name>&type=nama&page=&per_page=
// It matches part of the stored name, and the stored names are written with dots ("SDN. BHD."), so the legal
// form is removed from the query and the names are compared after normalising them.
const BASE = 'https://teduh.kpkt.gov.my/api/developer-swasta';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PER_PAGE = 30;
const MAX_PAGES = 8;
const BUDGET_MS = 45000;

const LEGAL_TAIL = /[\s.,]*\b(SENDIRIAN\s+BERHAD|SDN\.?\s*BERHAD|SDN\.?\s*BHD\.?|SDN\.?|BERHAD|BHD\.?)\s*$/;

function upper(s) { return String(s || '').toUpperCase(); }

// Upper case, brackets removed, only letters, digits and single spaces.
function clean(raw) {
  return upper(raw).replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Split a name into its core (no legal form) and a canonical legal form.
function splitLegal(raw) {
  let s = clean(raw);
  let legal = '';
  const m = s.match(/(SENDIRIAN BERHAD|SDN BERHAD|SDN BHD|SDN|BERHAD|BHD|PLT|LLP|LTD|LIMITED)$/);
  if (m) {
    const tok = m[1];
    if (tok === 'SENDIRIAN BERHAD' || tok === 'SDN BERHAD' || tok === 'SDN BHD') legal = 'SDN BHD';
    else if (tok === 'BERHAD' || tok === 'BHD') legal = 'BHD';
    else if (tok === 'LTD' || tok === 'LIMITED') legal = 'LTD';
    else legal = tok;
    s = s.slice(0, m.index).trim();
  }
  return { core: s, legal };
}

// The same company: same core name, and the same legal form when both names state one.
function relation(keyword, site) {
  const k = splitLegal(keyword);
  const s = splitLegal(site);
  const kc = k.core.replace(/ /g, '');
  const sc = s.core.replace(/ /g, '');
  if (!kc || kc !== sc) return 'other';
  if (!k.legal || !s.legal || k.legal === s.legal) return 'same';
  return 'legal_differs';
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url: source_url || '', excerpt: String(excerpt || '').slice(0, 500) };
}

function toRecord(d) {
  return {
    name: d.namaPemaju || '',
    kod_pemaju: d.kodPemaju || '',
    licence_no: d.noLesen || '',
    licence_from: d.lesenMula || '',
    licence_to: d.lesenTamat || '',
    registered_address: d.alamatDaftar || '',
    business_address: d.alamatPerniagaan || '',
    projects_total: d.jumlahProjek ?? null,
    sick_projects: d.projek_sakit_count ?? null,
    abandoned_projects: d.projek_terbengkalai_count ?? null,
    projects: (Array.isArray(d.projek) ? d.projek : []).map(p => ({
      name: p.nama || '', state: p.negeri || '', district: p.daerah || '', price: p.harga || '',
      status: p.status || '', category: p.kategori || '',
    })),
  };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  let firstUrl = '';
  try {
    const input = String(keyword || '').trim();
    const rawCore = upper(input).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(LEGAL_TAIL, '').replace(/[\s.,]+$/, '').trim();
    const variants = [...new Set([rawCore, clean(rawCore)])].filter(Boolean);
    if (variants.length === 0) {
      return out('couldnt_check', 'other', [], BASE, 'no company name left after removing the legal form');
    }

    const matches = [];
    const seen = new Set();
    let matchedUrl = '';
    let scanned = 0;
    let near = '';
    let complete = true;

    for (const term of variants) {
      let page = 1;
      let lastPage = 1;
      do {
        if (Date.now() - started > BUDGET_MS) {
          if (matches.length) break;
          return out('couldnt_check', 'timeout', [], firstUrl || BASE, 'TEDUH search did not finish within the time limit');
        }
        const url = `${BASE}?${new URLSearchParams({ page: String(page), per_page: String(PER_PAGE), q: term, type: 'nama' })}`;
        if (!firstUrl) firstUrl = url;
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(25000),
        });
        if (res.status === 403 || res.status === 429) {
          return out('couldnt_check', 'blocked', [], url, `HTTP ${res.status}`);
        }
        if (!res.ok) {
          return out('couldnt_check', 'http_error', [], url, `HTTP ${res.status}`);
        }
        const text = await res.text();
        if (/captcha|access denied|just a moment|cf-chl/i.test(text)) {
          return out('couldnt_check', 'blocked', [], url, text.slice(0, 200));
        }
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        if (!json || !Array.isArray(json.data) || !json.meta) {
          return out('couldnt_check', 'layout_changed', [], url, text.slice(0, 200));
        }
        lastPage = Number(json.meta.last_page) || 1;
        for (const d of json.data) {
          scanned++;
          const rel = relation(input, d.namaPemaju || '');
          if (rel === 'same') {
            const key = d.kodPemaju || d.namaPemaju;
            if (!seen.has(key)) {
              seen.add(key);
              matches.push(toRecord(d));
              matchedUrl = matchedUrl || url;
            }
          } else if (rel === 'legal_differs' && !near) {
            near = d.namaPemaju;
          }
        }
        page++;
      } while (page <= lastPage && page <= MAX_PAGES);
      if (page <= lastPage) complete = false;
      if (matches.length) break;
    }

    if (matches.length) {
      const m = matches[0];
      return out('found', '', matches, matchedUrl || firstUrl,
        `TEDUH licensed developer: ${m.name} (${m.kod_pemaju}), licence ${m.licence_no} from ${m.licence_from} to ${m.licence_to}, ${m.projects_total ?? 0} project(s)`);
    }
    if (!complete) {
      return out('couldnt_check', 'other', [], firstUrl,
        `more than ${MAX_PAGES} result pages for "${variants[0]}"; not all were checked`);
    }
    const nearText = near ? ` The site lists "${near}", which has a different legal form.` : '';
    return out('not_found', '', [], firstUrl,
      `0 licensed developers on TEDUH match "${input}" (searched "${variants.join('" and "')}", ${scanned} result(s) checked).${nearText}`);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', [], firstUrl || BASE, String(err?.message || err));
  }
}
