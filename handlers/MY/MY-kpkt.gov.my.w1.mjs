export const meta = { task: 'MY-kpkt.gov.my', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'licence_no', 'url_or_app'],
  canary: { found: 'BIG PAY LATER SDN. BHD.', not_found: 'Syarikat Pinjaman Fiktif Sdn Bhd' } };

// KPKT (Bahagian Kawalan Kredit Komuniti) PDF list: licensed PPW / Kredit Komuniti companies with approval for online lending.
// Source page: https://www.kpkt.gov.my/index.php/pages/view/646 (Muat Turun Maklumat Berkaitan BKK > PPW > Pemberian Pinjam Wang Dalam Talian).
const PDF_URL = 'https://www.kpkt.gov.my/kpkt/resources/user_1/MENGENAI%20KPKT/BORANG/BPWG/PPW/PPW_PEMBERIAN_DALAM_TALIAN/SENARAI_PPW_DENGAN_KELULUSAN_MENJALANKAN_ONLINE_MONEYLENDING_17092026.pdf';
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
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    if (head !== '%PDF-') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL,
               excerpt: `expected a PDF, got: ${new TextDecoder().decode(bytes.slice(0, 120))}` };
    }

    // The PDF is handed to the hub, which reads it. The handler does not match names itself.
    return { status: 'couldnt_check', reason: 'pdf', records: [], source_url: PDF_URL,
             excerpt: `PDF list, ${bytes.length} bytes, for company: ${keyword}` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: PDF_URL,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
