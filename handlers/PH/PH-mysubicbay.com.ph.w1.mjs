export const meta = { task: 'PH-mysubicbay.com.ph', want: 'w1', tier: 1, method: 'get', pdf: true, input: 'company name',
  fields: ['name', 'vzrc_no', 'issued_date'],
  canary: { found: 'SANCHEON CORP.', not_found: 'Hindi Nakatalang Kompanya Inc.' } };

// The SBMA page "List of SBF locators with issued VAT-ZERO RATING CERTIFICATE (VZRC)" embeds the current list as a PDF.
// This handler does not search the PDF: it finds the PDF address on the page, checks the file is a PDF, and hands the
// address to the hub, which reads the PDF itself.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_PAGE = 'https://invest.mysubicbay.com.ph/list-of-sbf-locators-with-issued-vat-zero-rating-certificate-vzrc';

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt).slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const pageRes = await fetch(LIST_PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pageRes.status === 403 || pageRes.status === 429) return couldnt('blocked', LIST_PAGE, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return couldnt('http_error', LIST_PAGE, `HTTP ${pageRes.status}`);

    const html = await pageRes.text();
    const m = html.match(/<iframe[^>]*\bsrc="([^"]+\.pdf)"/i);
    if (!m) return couldnt('layout_changed', LIST_PAGE, 'no PDF list found on the page');
    const pdfUrl = new URL(m[1], LIST_PAGE).href;

    const pdfRes = await fetch(pdfUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pdfRes.status === 403 || pdfRes.status === 429) return couldnt('blocked', pdfUrl, `HTTP ${pdfRes.status}`);
    if (!pdfRes.ok) return couldnt('http_error', pdfUrl, `HTTP ${pdfRes.status}`);

    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 5));
    if (head !== '%PDF-') return couldnt('layout_changed', pdfUrl, `not a PDF, starts with: ${head}`);

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: pdfUrl,
      excerpt: `PDF list of VZRC locators, ${bytes.length} bytes; the hub reads the PDF`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return couldnt(timeout ? 'timeout' : 'other', LIST_PAGE, String(err?.message || err));
  }
}
