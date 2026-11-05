// CMCF does not publish an HTML ruling search. Case outcomes are yearly
// Complaints Bureau PDFs in the media library. This handler only finds those
// PDFs. It does not read them.
export const meta = {
  task: 'MY-contentforum.my',
  want: 'w1',
  tier: 1,
  method: 'json_api',
  pdf: true,
  input: 'company name',
  fields: ['pdf_title', 'pdf_url'],
  canary: { found: 'Unilever (Malaysia) Holdings Sdn Bhd', not_found: 'Kingdom Digital' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LIST = 'https://contentforum.my/wp-json/wp/v2/media?search=complaint&per_page=100&_fields=source_url,title,mime_type';

function couldnt(reason, source_url, excerpt) {
  return {
    status: 'couldnt_check',
    reason,
    records: [],
    source_url,
    excerpt: String(excerpt || '').replace(/\s+/g, ' ').slice(0, 500),
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#039;/g, "'");
}

function isDecisionPdf(item) {
  if (!item || item.mime_type !== 'application/pdf') return false;
  const blob = decodeEntities(item.title?.rendered || '') + ' ' + (item.source_url || '');
  return /complaint/i.test(blob) && /bureau|decision|cases|case/i.test(blob);
}

export default async function lookup(keyword) {
  const q = String(keyword ?? '').trim();
  try {
    if (!q) return couldnt('other', LIST, 'empty keyword');
    const res = await fetch(LIST, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    const head = text.slice(0, 400);
    if (res.status === 401 || res.status === 403 || res.status === 429 || /just a moment|cf-browser-verification|captcha/i.test(head)) {
      return couldnt('blocked', LIST, 'HTTP ' + res.status + ' ' + head);
    }
    if (!res.ok) return couldnt('http_error', LIST, 'HTTP ' + res.status);
    let data;
    try { data = JSON.parse(text); } catch { return couldnt('layout_changed', LIST, head); }
    if (!Array.isArray(data)) return couldnt('layout_changed', LIST, head);
    const pdfs = data.filter(isDecisionPdf).map((item) => ({
      title: decodeEntities(item.title.rendered).replace(/\s+/g, ' ').trim(),
      url: item.source_url,
    }));
    if (pdfs.length < 5) {
      return couldnt('layout_changed', LIST, 'expected Complaints Bureau decision PDFs, found ' + pdfs.length);
    }
    pdfs.sort((a, b) => {
      const ya = Math.max(0, ...((a.title + a.url).match(/20\d{2}/g) || []).map(Number));
      const yb = Math.max(0, ...((b.title + b.url).match(/20\d{2}/g) || []).map(Number));
      return yb - ya;
    });
    const lines = pdfs.map((p) => p.title + ' ' + p.url).join(' | ');
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: pdfs[0].url,
      excerpt: ('Complaints Bureau decisions are PDF tables (date, complainant, category, case, action taken), ' + pdfs.length + ' files. Newest: ' + pdfs[0].url + '. Also ' + lines).slice(0, 500),
    };
  } catch (err) {
    const reason = /timeout|aborted|ETIMEDOUT/i.test(String(err?.message || err)) ? 'timeout' : 'other';
    return couldnt(reason, LIST, err?.message || err);
  }
}
