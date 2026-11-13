export const meta = { task: 'NL-kiwaregister.nl', want: 'w1', tier: 1, method: 'get', pdf: true, input: 'company name',
  fields: ['stamnummer', 'rechtsvorm', 'name', 'street', 'house_number', 'postcode', 'city', 'date_granted'],
  canary: { found: 'Taxicentrale Witteveen B.V.', not_found: 'Niet Bestaande Taxi Onderneming B.V.' } };

// The site publishes its taxi permit-holder list ("Overzicht vergunninghouders taxivervoer") as a PDF.
// The handler finds that PDF's address on the taxi permit page, checks the file really is a PDF, and hands it over.
// The hub reads the PDF itself, so this handler never answers found or not_found.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAGE = 'https://www.kiwaregister.nl/nl/taxi/vergunning-voor-taxivervoer';
const PDF_RE = /(?:href|src)=["']([^"']*\/getmedia\/[^"']*Taxi_Vergunninghouders-taxivervoer[^"']*\.pdf)["']/i;
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/pdf,*/*;q=0.8' };

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let source = PAGE;
  try {
    const page = await fetch(PAGE, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (page.status === 403 || page.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${page.status}` };
    }
    if (!page.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${page.status}` };
    }
    const html = await page.text();
    const m = html.match(PDF_RE);
    if (!m) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE,
               excerpt: 'no taxi permit-holder PDF link on the taxi permit page' };
    }
    const pdfUrl = new URL(m[1].replace(/&amp;/g, '&'), page.url || PAGE).href;
    source = pdfUrl;

    const pdf = await fetch(pdfUrl, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (pdf.status === 403 || pdf.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: pdfUrl, excerpt: `HTTP ${pdf.status}` };
    }
    if (!pdf.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: pdfUrl, excerpt: `HTTP ${pdf.status}` };
    }
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const magic = String.fromCharCode(...bytes.subarray(0, 5));
    if (magic !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: pdfUrl,
               excerpt: 'the address did not return a PDF' };
    }
    return { status: 'couldnt_check', reason: 'pdf', records: [], source_url: pdfUrl,
             excerpt: `Taxi permit-holder list (PDF, ${bytes.length} bytes); the hub reads it` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: source,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
