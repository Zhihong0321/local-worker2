// BfArM: "Registrierte Arzneimittelhändler" (Versandhandelsregister), list of sonstige Händler (VHR-EH).
// The site publishes this as a PDF list; the handler only checks the PDF is really there and hands it to the hub,
// which reads the PDF itself (pdf: true). It does not match names here.
export const meta = { task: 'DE-bfarm.de', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'address', 'registration_number', 'websites', 'supervising_authority'],
  canary: { found: '1A Medizintechnik GmbH', not_found: 'Nordlicht Phantasie Versandhandel GmbH' } };

const PDF_URL = 'https://versandhandel.dimdi.de/pdfs/vhr-eh.pdf';
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
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL,
               excerpt: `expected a PDF, got: ${head}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `PDF list of registered mail-order retailers (VHR-EH); company searched: ${keyword}`,
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
