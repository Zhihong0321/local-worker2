export const meta = {
  task: 'ID-gapensi.or.id',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'pimpinan', 'certificate_number', 'qualification', 'kta_date', 'address', 'kabupaten_kota', 'province'],
  canary: { found: 'CV. COPPO BOLA KONSTRUKSI', not_found: 'PT Perusahaan Fiktif Tidak Terdaftar' },
};

const BASE = 'https://gapensi.or.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words. The site's name search fails when they are typed ("CV. COPPO" finds nothing,
// "COPPO" finds the company), so they are dropped from the search text only. The match itself keeps them.
const LEGAL_TOKENS = new Set(['pt', 'cv', 'ud', 'persero', 'tbk']);

// Labels of the detail panel (one modal per listed company, already in the search page).
const LABELS = {
  'Nama Badan Usaha': 'name',
  'Nama Pimpinan': 'pimpinan',
  'Nomor Sertifikat': 'certificate_number',
  'Kualifikasi': 'qualification',
  'Tgl KTA': 'kta_date',
  'Alamat': 'address',
  'Kabupaten Kota': 'kabupaten_kota',
  'Propinsi': 'province',
};

function normalize(str) {
  return (str || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchText(keyword) {
  const tokens = keyword.trim().split(/\s+/).filter((t) => !LEGAL_TOKENS.has(normalize(t)));
  const core = tokens.join(' ').trim();
  return core || keyword.trim();
}

function parseRecords(html) {
  const records = [];
  const blocks = html.split(/id="modal_company\d+"/).slice(1);
  for (const block of blocks) {
    const end = block.indexOf('</ul>');
    const body = end >= 0 ? block.slice(0, end) : block;
    const rec = {};
    const re = /<div class="u-wd--35p">([\s\S]*?)<\/div>\s*<div class="u-wd--5p">:<\/div>\s*<div class="u-wd--60p">([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(body))) {
      const key = LABELS[cleanText(m[1])];
      if (key) rec[key] = cleanText(m[2]);
    }
    if (rec.name) records.push(rec);
  }
  return records;
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = typeof keyword === 'string' ? keyword.trim() : '';
  const searchUrl = `${BASE}/anggota?keyword=${encodeURIComponent(searchText(input))}&limit=200`;
  if (!input) {
    return { status: 'couldnt_check', reason: 'other', records: [], source_url: searchUrl, excerpt: 'empty company name' };
  }

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id,en;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: searchUrl, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const finalPath = (() => { try { return new URL(res.url || searchUrl).pathname; } catch { return ''; } })();
    if (finalPath.startsWith('/login') || /captcha|cf-chl|Just a moment/i.test(html)) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: searchUrl, excerpt: 'login or bot check page' };
    }

    const countMatch = html.match(/Ditemukan\s+(\d+)\s+Anggota/i);
    if (!countMatch || !/Daftar Anggota/i.test(html)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: cleanText(html).slice(0, 300) };
    }
    const total = Number(countMatch[1]);

    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: searchUrl, excerpt: `Ditemukan 0 Anggota for "${input}"` };
    }

    const records = parseRecords(html);
    if (records.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: searchUrl, excerpt: `Ditemukan ${total} but no detail panels found` };
    }

    const target = normalize(input);
    const matches = records.filter((r) => normalize(r.name) === target);
    if (matches.length > 0) {
      const m = matches[0];
      return {
        status: 'found',
        reason: '',
        records: matches,
        source_url: searchUrl,
        excerpt: `${m.name}: ${m.qualification || ''}, Tgl KTA ${m.kta_date || ''}, ${m.kabupaten_kota || ''}, ${m.province || ''}`,
      };
    }

    if (records.length < total) {
      return {
        status: 'couldnt_check',
        reason: 'other',
        records: [],
        source_url: searchUrl,
        excerpt: `search reports ${total} results, only ${records.length} were read, none matched exactly`,
      };
    }

    const closest = records.slice(0, 5).map((r) => r.name).join(' | ');
    return {
      status: 'not_found',
      reason: '',
      records: [],
      source_url: searchUrl,
      excerpt: `Ditemukan ${total} Anggota, none named exactly "${input}". Closest: ${closest}`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: searchUrl,
      excerpt: String((err && err.message) || err).slice(0, 300),
    };
  }
}
