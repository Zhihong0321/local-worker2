export const meta = { task: 'SG-rop.mlaw.gov.sg', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['sno', 'name', 'address', 'file_reference_no'],
  canary: { found: '916 PAWNSHOP PRIVATE LIMITED', not_found: '新加坡典当有限公司' } };

// The official list of licensed pawnshops is one PDF (linked from rop.mlaw.gov.sg/information-for-pawners/
// list-of-licensed-pawnbrokers-in-singapore/). It has no search and no text layer the handler can read,
// so the handler only checks that the PDF is there and hands it to the hub, as the contract says for pdf sources.
const PDF_URL = 'https://rop.mlaw.gov.sg/files/List_of_Pawnshops_as_at_1_September_2026.pdf';
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
      excerpt: `Registry list is a PDF (${bytes.length} bytes); the hub reads it for: ${String(keyword).slice(0, 100)}`,
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
