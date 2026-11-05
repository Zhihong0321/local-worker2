export const meta = {
  task: 'MY-eperolehan.gov.my',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  pdf: true,
  input: 'company name',
  fields: ['name', 'registration_number', 'disciplinary_action'],
  canary: { found: 'Rewanas Sdn. Bhd.', not_found: 'Dezeno' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const pdfUrl = 'https://www.eperolehan.gov.my/documents/10182/100000150863147/KEPUTUSAN+MESYUARAT+JKTT+BIL.+1+2025+UNTUK+PORTAL+TERKINI+12082025.pdf/7353d5b2-5377-406f-9106-ecd3418a640f';
  try {
    const res = await fetch(pdfUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: pdfUrl,
        excerpt: `HTTP status ${res.status}`
      };
    }
    return {
      status: 'couldnt_check',
      reason: 'pdf',
      records: [],
      source_url: pdfUrl,
      excerpt: 'MOF Jawatankuasa Tindakan Tatatertib (JKTT) decision list is published as a direct PDF document.'
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: pdfUrl,
      excerpt: String(err)
    };
  }
}
