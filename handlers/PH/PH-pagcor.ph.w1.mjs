export const meta = { task: 'PH-pagcor.ph', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name'], canary: { found: 'Cebu Entertainment Gallery Inc.', not_found: 'Kompanyang Hindi Nakalista Inc.' } };

// PAGCOR "List of Licensees for Gaming Venue Operations" (Electronic Gaming Licensing Department), as of October 31, 2026.
// The site has no search; the hub reads this PDF itself, so the handler only confirms the file is really a PDF.
const PDF_URL = 'https://www.pagcor.ph/regulatory/pdf/List-of-Licensees-for-Gaming-Venue-Operations.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 5));
    if (head !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF, first bytes: ${head}` };
    }
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of licensees for gaming venue operations (${bytes.length} bytes) for keyword: ${keyword}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timeout ? 'timeout' : 'other',
      records: [],
      source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
