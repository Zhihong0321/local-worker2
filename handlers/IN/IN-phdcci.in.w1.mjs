export const meta = { task: 'IN-phdcci.in', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'authorized_representative', 'designation', 'sector'],
  canary: { found: 'A&A Build Projects P Ltd.', not_found: 'नमस्ते उद्योग प्राइवेट लिमिटेड' } };

// The PHDCCI "List of Central Members" PDF, linked from https://www.phdcci.in/about-us/list-of-members/ (public, no login).
const PDF_URL = 'https://www.phdcci.in/about-us/list-of-members/List%20of%20Central%20Members-%20PHDCCI.pdf';
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
               excerpt: `expected a PDF, got bytes starting "${head}"` };
    }

    // A PDF list: the hub reads the PDF itself and matches the company name there.
    return { status: 'couldnt_check', reason: 'pdf', records: [], source_url: PDF_URL,
             excerpt: `PDF list of central members (${bytes.length} bytes) for "${String(keyword).slice(0, 120)}"` };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: PDF_URL,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
