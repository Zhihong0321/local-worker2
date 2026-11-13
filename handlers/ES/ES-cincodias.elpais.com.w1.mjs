export const meta = {
  task: 'ES-cincodias.elpais.com',
  want: 'w1',
  tier: 2,
  method: 'embedded_json',
  pdf: false,
  input: 'company name',
  fields: ['name', 'nif', 'directory_id', 'detail_url', 'legal_form', 'commercial_title', 'address', 'postcode',
    'province', 'municipality', 'cnae', 'cnae_text', 'telephone', 'web', 'detail_note'],
  canary: { found: 'MERCADONA SA', not_found: 'PANADERIA INEXISTENTE XYZ SL' },
};

const BASE = 'https://cincodias.elpais.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that only count at the END of a name, so "MERCADONA SA" compares as "MERCADONA".
const LEGAL_TAIL = new Set(['SA', 'SL', 'SLU', 'SAU', 'SLL', 'SRL', 'SC', 'SCP', 'SLP', 'SCOOP', 'SOCIEDAD', 'ANONIMA', 'LIMITADA', 'UNIPERSONAL']);

/** Upper case, no accents, no dots or other punctuation, trailing legal form removed. U+FFFD (a letter the site lost) is kept. */
function baseName(str) {
  const s = String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[.'’`]/g, '').replace(/[^A-Z0-9�]+/g, ' ').trim();
  const t = s ? s.split(' ') : [];
  while (t.length > 1 && LEGAL_TAIL.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

/** Same company? Equal after baseName. A U+FFFD on the site (a lost letter, e.g. Ñ) matches any one letter. */
function sameName(siteName, keyword) {
  const a = baseName(siteName);
  const b = baseName(keyword);
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && a[i] !== '�') return false;
  }
  return true;
}

function getPage(url) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
    signal: AbortSignal.timeout(25000),
  });
}

/** The site is Next.js: every page carries its data as JSON in __NEXT_DATA__. Returns pageProps or null. */
function nextPageProps(html) {
  const m = html.match(/<script[^>]*__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]).props?.pageProps ?? null;
  } catch {
    return null;
  }
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await search(keyword);
  // Node on Windows aborts ("Assertion failed ... async.c") when the process exits right after a fetch;
  // a short pause lets the sockets settle first.
  await new Promise((done) => setTimeout(done, 300));
  return answer;
}

async function search(keyword) {
  const searchUrl = `${BASE}/directorio-empresas/results/${encodeURIComponent(keyword)}`;
  const fail = (status, reason, excerpt) => ({
    status, reason, records: [], source_url: searchUrl, excerpt: String(excerpt).slice(0, 300),
  });

  try {
    const res = await getPage(searchUrl);
    if (res.status === 403 || res.status === 429) return fail('couldnt_check', 'blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('couldnt_check', 'http_error', `HTTP ${res.status}`);

    const html = await res.text();
    const page = nextPageProps(html);
    if (!page) {
      return /captcha|challenge-platform|cf-chl|access denied/i.test(html)
        ? fail('couldnt_check', 'blocked', 'bot check page')
        : fail('couldnt_check', 'layout_changed', html.slice(0, 200));
    }
    if (!Array.isArray(page.data) || typeof page.totalValues !== 'number') {
      return fail('couldnt_check', 'layout_changed', 'results page has no data list');
    }

    const matches = page.data.filter((r) => r && r._source && sameName(r._source.denomination?.fullName, keyword));
    if (matches.length === 0) {
      if (page.data.length < page.totalValues) {
        return fail('couldnt_check', 'other',
          `${page.totalValues} results, only ${page.data.length} shown, none with this exact name`);
      }
      return fail('not_found', '', `${page.totalValues} result(s), none with this name`);
    }

    // One record per match. Each detail page is read in parallel; a failed detail page keeps the search-level fields.
    const records = await Promise.all(matches.map(async (r) => {
      const src = r._source;
      const detailUrl = `${BASE}/directorio-empresas/empresa/${encodeURIComponent(src.ibers)}/` +
        `${encodeURIComponent(String(src.idWeb || '').replace(/\//g, '-'))}`;
      const rec = {
        name: src.denomination?.fullName || '',
        nif: src.nreg || '',
        directory_id: String(src.ibers || ''),
        detail_url: detailUrl,
        legal_form: '', commercial_title: '', address: '', postcode: '', province: '', municipality: '',
        cnae: '', cnae_text: '', telephone: '', web: '', detail_note: '',
      };
      try {
        const dres = await getPage(detailUrl);
        if (!dres.ok) {
          rec.detail_note = `detail page HTTP ${dres.status}`;
          return rec;
        }
        const d = nextPageProps(await dres.text())?.detail;
        if (!d) {
          rec.detail_note = 'detail page has no data';
          return rec;
        }
        rec.name = d.denomination?.fullName || rec.name;
        rec.legal_form = d.denomination?.legalForm || '';
        rec.commercial_title = d.commercialTitle || '';
        rec.address = d.address?.fullAddress || '';
        rec.postcode = d.address?.postcode || '';
        rec.province = d.geo?.admin1_desc || '';
        rec.municipality = d.geo?.admin3_desc || '';
        rec.cnae = d.cnae?.code || '';
        rec.cnae_text = d.cnae?.class_text || '';
        rec.telephone = d.telephone || '';
        rec.web = d.web || '';
      } catch (err) {
        rec.detail_note = 'detail page not read: ' + String(err?.message || err).slice(0, 120);
      }
      return rec;
    }));

    return {
      status: 'found',
      reason: '',
      records,
      source_url: searchUrl,
      excerpt: records.map((r) => `${r.name} | NIF ${r.nif} | ${r.address}`).join(' ; ').slice(0, 300),
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail('couldnt_check', timeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
