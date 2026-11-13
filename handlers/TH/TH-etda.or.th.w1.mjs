export const meta = { task: 'TH-etda.or.th', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'licence_no', 'services', 'status', 'pre_law_operator', 'licence_pdf'],
  canary: { found: 'ธนาคารกรุงไทย จำกัด (มหาชน)', not_found: 'บริษัท ทดสอบไม่มีอยู่จริง จำกัด' } };

const PAGE = 'https://www.etda.or.th/th/regulator/DigitalID/licence_DigitalID.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function cleanText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Compare company names by their core: Thai script only, no legal form, no spaces or punctuation.
function coreName(str) {
  return (str || '')
    .normalize('NFKC')
    .replace(/ํา/g, 'ำ')            // decomposed sara am -> sara am (the site writes both forms)
    .replace(/\*/g, '')
    .replace(/บริษัท|ห้างหุ้นส่วนจำกัด|จำกัด|มหาชน|บจก\.?|บมจ\.?|หจก\.?/g, '')
    .replace(/[\s()\-.,/]/g, '')
    .toLowerCase();
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const text = String(keyword || '').trim();
    if (!/[฀-๿]/.test(text)) {
      // The list is published in Thai only, so a name without Thai script cannot be compared with it.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE,
               excerpt: 'name has no Thai characters; the list is in Thai only, so it was not checked' };
    }

    const res = await fetch(PAGE, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (/captcha|cf-chl|access denied/i.test(html.slice(0, 5000))) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE, excerpt: 'bot check page' };
    }

    // The licence table: one row per licence, 5 cells: licence no. | name | services | PDF | status icon.
    const table = html.match(/<table[\s\S]*?<\/table>/i)?.[0] || '';
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).filter((r) => /ธพส\.\s*\d{3}-\d{4}/.test(r));
    if (!html.includes('เลขที่ใบอนุญาต') || rows.length === 0) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE, excerpt: html.slice(0, 300) };
    }

    const wanted = coreName(text);
    if (!wanted) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE, excerpt: 'name has no usable text after removing the legal form' };
    }

    const records = [];
    for (const row of rows) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      if (cells.length < 4) continue;
      const licenceNo = cleanText(cells[0]);
      const name = cleanText(cells[1]);
      if (coreName(name) !== wanted) continue;
      const services = (cells[2].match(/<br\s*\/?>|\n/i) ? cells[2].split(/<br\s*\/?>|\n/i) : [cells[2]])
        .map((s) => cleanText(s).replace(/^-\s*/, ''))
        .filter(Boolean);
      const pdf = cells[3].match(/href="([^"]+\.pdf)"/i);
      const statusAlt = cells[4]?.match(/alt="([^"]*)"/i)?.[1] || '';
      const statusTail = cleanText(cells[4] || '').replace(/^\s*$/, '');
      records.push({
        name,
        licence_no: licenceNo,
        services,
        status: [statusAlt, statusTail].filter(Boolean).join(' ').trim(),
        pre_law_operator: /<span[^>]*>\s*\*\s*<\/span>/i.test(cells[1]),
        licence_pdf: pdf ? new URL(pdf[1], PAGE).href : '',
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: PAGE,
        excerpt: `no match among ${rows.length} licensed Digital ID providers listed on the page`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: PAGE,
      excerpt: records.map((r) => `${r.licence_no} ${r.name}`).join(' | ').slice(0, 500),
    };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'couldnt_check',
      reason: timedOut ? 'timeout' : 'other',
      records: [],
      source_url: PAGE,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
