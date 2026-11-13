export const meta = { task: 'TH-aeo.customs.go.th', want: 'w1', tier: 1, method: 'static_list', pdf: true, input: 'company name',
  fields: ['name', 'code'], canary: { found: 'บริษัท ซันไชน์ ลอจิสติคส์ จ ำกัด', not_found: 'บริษัท ทดสอบ ไม่มีในรายชื่อ จำกัด' } };

const BASE = 'https://aeo.customs.go.th/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_TITLE = 'ตารางแสดงรายชื่อผู้ประกอบการระดับมาตรฐานเออีโอ';

const fail = (reason, source_url, excerpt) => ({ status: 'couldnt_check', reason, records: [], source_url, excerpt });

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 *  The site publishes the AEO operator list only as a PDF (monthly). This handler finds the newest list PDF,
 *  checks that it really is a PDF, and hands it to the hub, which reads it. */
export default async function lookup(keyword) {
  const deadline = Date.now() + 55000;
  const get = (url) => fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8' },
    signal: AbortSignal.timeout(Math.max(1000, Math.min(25000, deadline - Date.now()))),
  });
  try {
    // Step 1: home page -> newest AEO operator table item
    const homeRes = await get(BASE);
    if (homeRes.status === 403 || homeRes.status === 429) return fail('blocked', BASE, `HTTP ${homeRes.status}`);
    if (!homeRes.ok) return fail('http_error', BASE, `HTTP ${homeRes.status}`);
    const home = await homeRes.text();
    const itemRe = /<a href="javascript:send_to\('cont_strc_simple_with_date\.php\?current_id=([0-9a-f]+)'\)" class="list-group-item">([\s\S]*?)<\/a>/g;
    let m, itemId = null;
    while ((m = itemRe.exec(home))) {
      if (m[2].includes(LIST_TITLE)) { itemId = m[1]; break; }
    }
    if (!itemId) return fail('layout_changed', BASE, 'AEO operator list item not found on the home page');

    // Step 2: item page -> the PDF link
    const itemUrl = `${BASE}cont_strc_simple_with_date.php?lang=th&current_id=${itemId}`;
    const itemRes = await get(itemUrl);
    if (itemRes.status === 403 || itemRes.status === 429) return fail('blocked', itemUrl, `HTTP ${itemRes.status}`);
    if (!itemRes.ok) return fail('http_error', itemUrl, `HTTP ${itemRes.status}`);
    const itemHtml = await itemRes.text();
    const pdfMatch = itemHtml.match(/href="(data_files\/[^"]+\.pdf)"/i);
    if (!pdfMatch) return fail('layout_changed', itemUrl, 'no PDF link on the list item page');
    const pdfUrl = new URL(pdfMatch[1], BASE).href;

    // Step 3: check the file really is a PDF
    const pdfRes = await get(pdfUrl);
    if (pdfRes.status === 403 || pdfRes.status === 429) return fail('blocked', pdfUrl, `HTTP ${pdfRes.status}`);
    if (!pdfRes.ok) return fail('http_error', pdfUrl, `HTTP ${pdfRes.status}`);
    const head = new TextDecoder().decode((await pdfRes.arrayBuffer()).slice(0, 5));
    if (head !== '%PDF-') return fail('layout_changed', pdfUrl, `not a PDF: starts with ${JSON.stringify(head)}`);

    return { status: 'couldnt_check', reason: 'pdf', records: [], source_url: pdfUrl,
      excerpt: `${LIST_TITLE} (item ${itemId}); keyword: ${keyword}` };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : 'other', BASE, String(err?.message || err));
  }
}
