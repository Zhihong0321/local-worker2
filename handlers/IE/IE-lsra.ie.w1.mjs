export const meta = { task: 'IE-lsra.ie', want: 'w1', tier: 1, method: 'get', pdf: true, input: 'company name',
  fields: ['name', 'address', 'notification_date', 'commencement_date', 'telephone', 'email', 'partners'],
  canary: { found: 'Heres Law', not_found: 'Comhlacht Dlíthiúil Teoranta' } };

// Register of Legal Partnerships (LSRA), as at 26 May 2026. A PDF list: the hub reads the PDF itself.
const PDF_URL = 'https://www.lsra.ie/wp-content/uploads/2026/05/Register-of-Legal-Partnerships-as-at_26-05-26.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF: ${head}` };
    }
    // The register is a PDF: this handler only confirms it is reachable. The hub reads it and matches the name.
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF register (${bytes.length} bytes) for "${keyword}"; the hub reads it`,
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
