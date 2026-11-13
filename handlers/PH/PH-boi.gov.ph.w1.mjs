export const meta = {
  task: 'PH-boi.gov.ph',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: true,
  input: 'company name',
  fields: ['name', 'tin', 'boi_registration_no', 'vat_zero_rating_certificate_no', 'certificate_date', 'validity_period'],
  canary: { found: 'EMAPTA PHILIPPINES, INC.', not_found: 'Kumpanyang Hindi Nakalista Inc.' },
};

// The site publishes its registered export enterprises (VAT zero-rating certificate holders) as one PDF per year.
// The newest list is linked from https://boi.gov.ph/registered-export-enterprises-with-vat-zero-rating-certificate/
const PDF_URL = 'https://boi.gov.ph/wp-content/uploads/2026/09/2026-VAT-Zero-Rating-Certificate-Sept.pdf';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }

    // The hub reads the PDF itself; the handler only confirms the address really serves a PDF.
    const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 5);
    const magic = String.fromCharCode(...head);
    if (magic !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF, starts with: ${magic}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of registered export enterprises with VAT zero-rating certificate; looking for "${keyword}"`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: PDF_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
