export const meta = {
  task: 'CH-bazg.admin.ch',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['nr', 'name', 'postal_code', 'location', 'registration_date', 'deletion_date', 'collective_mark_no'],
  canary: { found: 'Florian Favre SA', not_found: 'Zzyzx Edelmetall Manufaktur AG' },
};

// The site has no name search. It publishes static PDF lists of the holders of collective mark no. 5 (2025 edition).
// The lists for collective marks no. 1, 3 and 4 are separate PDFs and are NOT covered by this handler.
const PDF_URL = 'https://www.bazg.admin.ch/dam/de/sd-web/osb3K1Qv7qCH/Liste_Ayants%20droit_PM%20collectifs%20no.%205_2025.pdf';
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
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF: ${head}` };
    }

    // The hub reads the PDF itself: hand it over with reason 'pdf'. Covers collective mark no. 5 only.
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of holders of collective mark no. 5 (BAZG, last change 19.12.2025). Keyword: ${keyword}. Lists for collective marks no. 1, 3, 4 are separate PDFs and are not covered here.`,
    };
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: PDF_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
