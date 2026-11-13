export const meta = { task: 'RU-akit.ru', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'website'], canary: { found: 'Ozon', not_found: 'Несуществующая Компания ООО' } };

// AKIT "Перечень членов и партнёров" (members and partners list), linked from https://akit.ru/business/partners.
const PDF_URL = 'https://admin.akit.ru/wp-content/uploads/2026/10/Perechen-chlenov-i-partnyorov-AKIT-po-sost.na-19.10.2026-.pdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PDF_URL, excerpt: `not a PDF, starts with ${JSON.stringify(head)}` };
    }
    // The list is a PDF: the hub reads it itself.
    return { status: 'couldnt_check', reason: 'pdf', records: [], source_url: PDF_URL, excerpt: `PDF member list, ${bytes.length} bytes` };
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return { status: 'couldnt_check', reason, records: [], source_url: PDF_URL, excerpt: String(err?.message || err).slice(0, 300) };
  }
}
