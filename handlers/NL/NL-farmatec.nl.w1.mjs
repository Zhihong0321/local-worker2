export const meta = { task: 'NL-farmatec.nl', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'street', 'house_number', 'postcode', 'city', 'registration_number', 'start_date'],
  canary: { found: 'Nafinco B.V.', not_found: 'Onbestaand Farmaceutisch Bedrijf B.V.' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DOC_PAGE = 'https://www.farmatec.nl/documenten/2025/03/03/overzicht-geldige-bem-registraties-2026';
const PDF_FALLBACK = 'https://www.farmatec.nl/site/binaries/site-content/collections/documents/2025/03/03/overzicht-geldige-bem-registraties-2026/overzicht-geldige-bem-02-11-2026.pdf';

function fail(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    // Step 1: the document page names the current PDF (the file name carries a date).
    const pageRes = await fetch(DOC_PAGE, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
    if (pageRes.status === 403 || pageRes.status === 429) return fail('blocked', DOC_PAGE, `HTTP ${pageRes.status}`);
    if (!pageRes.ok) return fail('http_error', DOC_PAGE, `HTTP ${pageRes.status}`);
    const pageHtml = await pageRes.text();

    const linkMatch = pageHtml.match(/class="download-list__link"[^>]*href="([^"]+\.pdf)"/i)
      || pageHtml.match(/href="([^"]+\.pdf)"[^>]*class="download-list__link"/i);
    const pdfUrl = linkMatch ? new URL(linkMatch[1].replace(/&amp;/g, '&'), DOC_PAGE).href : PDF_FALLBACK;

    // Step 2: check the PDF really is a PDF. The hub reads its rows itself.
    const pdfRes = await fetch(pdfUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
    if (pdfRes.status === 403 || pdfRes.status === 429) return fail('blocked', pdfUrl, `HTTP ${pdfRes.status}`);
    if (!pdfRes.ok) return fail('http_error', pdfUrl, `HTTP ${pdfRes.status}`);
    const head = new Uint8Array(await pdfRes.arrayBuffer()).slice(0, 5);
    const magic = String.fromCharCode(...head);
    if (magic !== '%PDF-') return fail('layout_changed', pdfUrl, `not a PDF, starts with ${JSON.stringify(magic)}`);

    return fail('pdf', pdfUrl, `PDF broker list (BEM registrations); look up "${keyword}" in it`);
  } catch (err) {
    const name = String(err?.name || '');
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return fail(reason, DOC_PAGE, err?.message || err);
  }
}
