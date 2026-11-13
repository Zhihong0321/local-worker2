export const meta = { task: 'IE-sipo.ie', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'register', 'year', 'pdf_url'],
  canary: { found: 'Aledo Construction Ltd.', not_found: 'Comhlacht Ficseanúil Teoranta' } };

// SIPO's "Information for corporate donors" page lists the Register of Corporate Donors: one entry per registered
// donor, each with its own PDF. The entry titles are plain HTML, so the handler reads the names from the page itself.
const PAGE_URL = 'https://www.sipo.ie/en/publication/15a8d-information-for-corporate-donors/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Legal-form words that are dropped from the END of a name only, so "Aledo Construction Ltd." and
// "ALEDO CONSTRUCTION LIMITED" both become "aledo construction". Applied to both sides of the comparison.
const LEGAL_FORMS = new Set(['ltd', 'limited', 'dac', 'plc', 'unlimited', 'uc', 'ulc', 'teoranta', 'teo', 'cuideachta', 'co', 'company']);

function decodeEntities(s) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] ?? m));
}

function cleanText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Comparable form of a company name: no accents, no case, no punctuation, no trailing legal form. */
function normName(s) {
  const tokens = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length && LEGAL_FORMS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function couldnt(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PAGE_URL, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const want = normName(keyword);
    if (!want) return couldnt('other', 'empty company name after normalising');

    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return couldnt('blocked', `HTTP ${res.status}`);
    if (!res.ok) return couldnt('http_error', `HTTP ${res.status}`);

    const html = await res.text();
    if (!html.includes('Register of Corporate Donors')) {
      return couldnt('layout_changed', html.slice(0, 300));
    }

    // Each entry: <p reboot-markdown-document-title id="download_title_NNN">NAME Register of Corporate Donors YEAR</p>
    // and a download link <a href="PDF" ... id="download_link_NNN">.
    const entries = [];
    const titleRe = /<p reboot-markdown-document-title[^>]*?id="download_title_(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = titleRe.exec(html)) !== null) {
      const title = cleanText(m[2]);
      const t = title.match(/^(.*?)\s+Register of Corporate Donors\s+(\d{4})$/);
      if (!t) continue;
      const linkRe = new RegExp(`<a href="([^"]+)"[^>]*\\bid="download_link_${m[1]}"`, 'i');
      const link = html.match(linkRe);
      let pdfUrl = '';
      if (link) {
        try { pdfUrl = new URL(decodeEntities(link[1]), PAGE_URL).href; } catch { pdfUrl = ''; }
      }
      entries.push({ name: t[1].trim(), register: 'Register of Corporate Donors', year: t[2], pdf_url: pdfUrl });
    }

    if (entries.length === 0) {
      return couldnt('layout_changed', 'no Register of Corporate Donors entries found on the page');
    }

    const matches = entries.filter((e) => normName(e.name) === want);
    if (matches.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE_URL,
        excerpt: `Not on the Register of Corporate Donors ${[...new Set(entries.map((e) => e.year))].join(', ')} (${entries.length} entries checked)`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matches,
      source_url: PAGE_URL,
      excerpt: matches.map((e) => `${e.name} - ${e.register} ${e.year}`).join('; ').slice(0, 500),
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(isTimeout ? 'timeout' : 'other', String(err?.message || err));
  }
}
