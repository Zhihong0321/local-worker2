export const meta = {
  task: 'MY-pka.gov.my',
  want: 'w1',
  tier: 1,
  method: 'url_template',
  input: 'company name',
  fields: ['name', 'address', 'phone', 'service_type', 'service_location', 'license_period'],
  canary: { found: 'GS EXPRESS LOGISTICS SDN BHD', not_found: 'DNE Logistics' },
};

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const url = `https://pkapp.pka.gov.my/ancillarycomp/cari.php?namasya=${encodeURIComponent(keyword)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: url, excerpt: `HTTP ${res.status}` };
    }

    const html = await res.text();
    if (!html.includes('Carian (Nama Syarikat)') && !html.includes('NAMA SYARIKAT')) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: url, excerpt: html.slice(0, 300) };
    }

    const rowMatches = html.match(/<tr bgcolor="(#FFFFFF|#F0E3C0)">([\s\S]*?)<\/tr>/g) || [];
    const allRecords = [];

    for (const rowHtml of rowMatches) {
      const cols = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [])
        .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim());
      if (cols.length >= 8) {
        allRecords.push({
          name: cols[1],
          address: cols[2],
          phone: cols[3],
          service_type: cols[5],
          service_location: cols[6],
          license_period: cols[7]
        });
      }
    }

    const kwNorm = normalize(keyword);
    const matched = allRecords.filter(r => {
      const nameNorm = normalize(r.name);
      return nameNorm.includes(kwNorm) || kwNorm.includes(nameNorm);
    });

    if (matched.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: url,
        excerpt: `Found 0 matching registered ancillary companies for ${keyword} (total search rows: ${allRecords.length})`
      };
    }

    return {
      status: 'found',
      reason: '',
      records: matched,
      source_url: url,
      excerpt: JSON.stringify(matched[0]).slice(0, 500)
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: `https://pkapp.pka.gov.my/ancillarycomp/cari.php?namasya=${encodeURIComponent(keyword)}`,
      excerpt: String(err?.message || err)
    };
  }
}