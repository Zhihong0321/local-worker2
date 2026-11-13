export const meta = { task: 'SG-nea.gov.sg', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['company_name', 'site_address', 'waste_type', 'waste_sub_type'],
  canary: { found: '5R METAL PTE. LTD.', not_found: '新加坡虚构环保私人有限公司' } };

// NEA's list of licensed Toxic Industrial Waste Collectors (TIWC), published as one PDF on nea.gov.sg.
// The hub reads the PDF itself; this handler only fetches it and checks that it really is a PDF.
const PDF_URL = 'https://www.nea.gov.sg/docs/default-source/tiw/tiwc-list/list-of-toxic-industrial-waste-collectors---aug-2026.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'user-agent': UA, 'accept': 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PDF_URL, excerpt: `HTTP ${res.status}` };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    if (head !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL,
        excerpt: `expected a PDF, got content starting "${head}"` };
    }

    return { status: 'couldnt_check', reason: 'pdf', records: [], source_url: PDF_URL,
      excerpt: `PDF list of licensed toxic industrial waste collectors (${bytes.length} bytes); look up "${keyword}" in it` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: PDF_URL,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
