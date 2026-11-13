export const meta = { task: 'ID-beacukai.go.id', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['no', 'name'], canary: { found: 'PT SHINDENGEN INDONESIA', not_found: 'PT Bumi Lestari Sejahtera Abadi Nusantara' } };

// The only company list on beacukai.go.id is the AEO certified-company PDF (178 companies, as of 30 June 2025),
// linked from https://beacukai.go.id/fasilitas-aeo. This handler only checks that the PDF is reachable; the hub reads
// the PDF and matches the company name itself.
const PDF_URL = 'https://onewebfile.beacukai.go.id/cdn/download/file/6861f58c846e515ab1cb7d41';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
               excerpt: `expected a PDF, got: ${String.fromCharCode(...bytes.slice(0, 120))}` };
    }

    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: PDF_URL,
      excerpt: `AEO company list PDF (${bytes.length} bytes) for "${keyword}"; the hub matches the name`,
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
