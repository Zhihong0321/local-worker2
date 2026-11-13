export const meta = { task: 'ES-seguridadaerea.gob.es', want: 'w1', tier: 1, method: 'get', pdf: true, input: 'company name',
  fields: ['operator', 'dba', 'aoc_number', 'fleets'],
  canary: { found: 'BINTER CANARIAS, S.A.', not_found: 'Aerolínea Inexistente de Prueba, S.L.' } };

// AESA publishes the Air Operator Certificate (AOC) register as one PDF list (airplanes and helicopters).
// The handler only checks that the PDF is reachable; the hub reads the PDF itself.
const PDF_URL = 'https://www.seguridadaerea.gob.es/sites/default/files/listado_aoc.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fail(reason, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url: PDF_URL, excerpt };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const res = await fetch(PDF_URL, {
      headers: { 'user-agent': UA, accept: 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return fail('blocked', `HTTP ${res.status}`);
    if (!res.ok) return fail('http_error', `HTTP ${res.status}`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    const magic = String.fromCharCode(...bytes.slice(0, 5));
    if (magic !== '%PDF-') return fail('layout_changed', `not a PDF, starts with: ${magic}`);

    return fail('pdf', `AOC list PDF, ${bytes.length} bytes, for keyword: ${keyword}`);
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', String(err.message || err));
    return fail('other', String(err?.message || err));
  }
}
