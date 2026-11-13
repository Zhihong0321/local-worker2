export const meta = { task: 'ID-ojk.go.id', want: 'w1', tier: 1, method: 'get', pdf: true, input: 'company name',
  fields: ['name', 'license_no', 'license_date', 'address'],
  canary: { found: 'PT BFI Finance Indonesia, Tbk', not_found: 'PT Nama Tidak Terdaftar Sama Sekali' } };

// OJK publishes the lembaga pembiayaan (finance company / venture capital / microfinance) register as one monthly PDF.
// The handler does not match names: it finds the newest monthly PDF, checks that it really is a PDF, and hands it to
// the hub with reason 'pdf'.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const INDEX_URL = 'https://ojk.go.id/id/kanal/iknb/data-dan-statistik/direktori/lembaga-pembiayaan/Default.aspx';
const ITEM_RE = /href="(\/id\/kanal\/iknb\/data-dan-statistik\/direktori\/lembaga-pembiayaan\/Pages\/Direktori-Lembaga-Pembiayaan-dan-[^"]+\.aspx)"/i;
const PDF_RE = /href="([^"]*\/Documents\/[^"]*\.pdf)"/i;

function couldnt(reason, source_url, excerpt) {
  return { status: 'couldnt_check', reason, records: [], source_url, excerpt };
}

async function get(url) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000) });
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    // 1. Index page: the list of monthly directory items, newest first.
    const idx = await get(INDEX_URL);
    if (idx.status === 403 || idx.status === 429) return couldnt('blocked', INDEX_URL, `HTTP ${idx.status}`);
    if (!idx.ok) return couldnt('http_error', INDEX_URL, `HTTP ${idx.status}`);
    const idxHtml = await idx.text();
    const item = idxHtml.match(ITEM_RE);
    if (!item) return couldnt('layout_changed', INDEX_URL, 'no monthly directory item link on the index page');

    // 2. Newest monthly item page: the PDF link.
    const itemUrl = new URL(item[1], INDEX_URL).href;
    const itemRes = await get(itemUrl);
    if (!itemRes.ok) return couldnt('http_error', itemUrl, `HTTP ${itemRes.status}`);
    const itemHtml = await itemRes.text();
    const pdf = itemHtml.match(PDF_RE);
    if (!pdf) return couldnt('layout_changed', itemUrl, 'no PDF link on the monthly directory page');
    const pdfUrl = new URL(pdf[1].replace(/&amp;/g, '&'), itemUrl).href;

    // 3. The PDF itself: it must really start with %PDF-.
    const pdfRes = await get(pdfUrl);
    if (pdfRes.status === 403 || pdfRes.status === 429) return couldnt('blocked', pdfUrl, `HTTP ${pdfRes.status}`);
    if (!pdfRes.ok) return couldnt('http_error', pdfUrl, `HTTP ${pdfRes.status}`);
    const head = new Uint8Array(await pdfRes.arrayBuffer()).subarray(0, 5);
    const magic = String.fromCharCode(...head);
    if (magic !== '%PDF-') return couldnt('layout_changed', pdfUrl, `not a PDF (starts with "${magic}")`);

    // 4. Hand over to the hub, which reads the PDF.
    return couldnt('pdf', pdfUrl, `OJK monthly register PDF (lembaga pembiayaan / PMV / LKM), keyword "${keyword}" not matched here`);
  } catch (err) {
    const name = err?.name || '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'other';
    return couldnt(reason, INDEX_URL, String(err?.message || err).slice(0, 300));
  }
}
