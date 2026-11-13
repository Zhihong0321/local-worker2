export const meta = {
  task: 'CH-pronovo.ch',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['name', 'address', 'subject', 'contract_value_chf', 'procedure', 'contract_start'],
  canary: { found: 'Braintec AG', not_found: 'Fantasiefirma Schweiz GmbH' },
};

// Pronovo's "Liste der Beschaffungen gemäss Art. 27 VöB (2025)": the supplier names are in the PDF itself.
// The hub reads the PDF; this handler only confirms the file is really a PDF and hands its address over.
const PDF_URL = 'https://pronovo.ch/?wpdmdl=19789&ind=0';
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
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF, starts with: ${head}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of Art. 27 VöB procurement awards (2025), ${bytes.length} bytes; company "${String(keyword || '').slice(0, 120)}" to be matched by the hub`,
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: isTimeout ? 'timeout' : 'other',
      records: [],
      source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
