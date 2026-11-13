export const meta = { task: 'SG-mpa.gov.sg', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['no', 'bunker_supplier', 'fuel_supplied', 'address', 'tel_no', 'person_to_contact', 'email'],
  canary: { found: 'Bunker B Pte Ltd', not_found: '幻想海洋私人有限公司' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_PAGE = 'https://www.mpa.gov.sg/port-marine-ops/marine-services/bunkering/bunkering-service-providers';
const PDF_LINK = /List-of-licensed-bunker-suppliers/i;

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

function reasonFor(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 *  The keyword is not used here: this source is a PDF list, so the hub reads the PDF and matches the name itself. */
export default async function lookup(keyword) {
  try {
    // Step 1: read the page that links to the licensed bunker suppliers PDF (the link changes when MPA re-issues it).
    const page = await fetch(LIST_PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (page.status === 403 || page.status === 429) return fail('blocked', LIST_PAGE, `HTTP ${page.status}`);
    if (!page.ok) return fail('http_error', LIST_PAGE, `HTTP ${page.status}`);
    const html = await page.text();

    const hrefs = [...html.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    const pick = hrefs.find((h) => PDF_LINK.test(h));
    if (!pick) return fail('layout_changed', LIST_PAGE, 'no "List of licensed bunker suppliers" PDF link on the page');
    const pdfUrl = new URL(pick, LIST_PAGE).href;

    // Step 2: check the PDF really is a PDF.
    const pdf = await fetch(pdfUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (pdf.status === 403 || pdf.status === 429) return fail('blocked', pdfUrl, `HTTP ${pdf.status}`);
    if (!pdf.ok) return fail('http_error', pdfUrl, `HTTP ${pdf.status}`);
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const magic = String.fromCharCode(...bytes.slice(0, 5));
    if (magic !== '%PDF-') return fail('layout_changed', pdfUrl, `not a PDF, starts with: ${magic}`);

    return fail('pdf', pdfUrl, 'List of licensed bunker suppliers in the Port of Singapore (PDF, read by the hub)');
  } catch (err) {
    return fail(reasonFor(err), LIST_PAGE, err && err.message);
  }
}
