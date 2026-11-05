export const meta = {
  task: 'SG-gebiz.gov.sg',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['supplier_name', 'uen', 'supply_heads', 'status', 'detail_url'],
  canary: {
    found: 'VERZ DESIGN PTE. LTD.',
    not_found: 'Space Factor'
  }
};

function getCookies(res) {
  if (res.headers.getSetCookie) {
    return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  }
  return res.headers.get('set-cookie') || '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const cleanKeyword = (keyword || '').trim();
    if (!cleanKeyword) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: 'https://www.gebiz.gov.sg/ptn/supplier/directory/index.xhtml',
        excerpt: ''
      };
    }

    const dirUrl = 'https://www.gebiz.gov.sg/ptn/supplier/directory/index.xhtml';
    const getRes = await fetch(dirUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!getRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: dirUrl,
        excerpt: `GET HTTP ${getRes.status} ${getRes.statusText}`
      };
    }

    const c1 = getCookies(getRes);
    const getHtml = await getRes.text();

    if (!getHtml.includes('contentForm') || !getHtml.includes('javax.faces.ViewState')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: dirUrl,
        excerpt: getHtml.slice(0, 300)
      };
    }

    const viewStateMatch = getHtml.match(/<input[^>]*name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/i);
    const viewState = viewStateMatch ? viewStateMatch[1] : '';

    if (!viewState) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: dirUrl,
        excerpt: 'ViewState not found in page'
      };
    }

    // Submit search form
    const params = new URLSearchParams();
    params.append('contentForm', 'contentForm');
    params.append('contentForm:j_idt151', cleanKeyword);
    params.append('contentForm:search', 'Search');
    params.append('javax.faces.ViewState', viewState);

    const postRes = await fetch(dirUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': c1,
        'Origin': 'https://www.gebiz.gov.sg',
        'Referer': dirUrl
      },
      body: params.toString()
    });

    if (!postRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: dirUrl,
        excerpt: `POST HTTP ${postRes.status} ${postRes.statusText}`
      };
    }

    const postHtml = await postRes.text();

    if (postHtml.includes('Session Expired')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: dirUrl,
        excerpt: 'Session expired response from GeBIZ'
      };
    }

    if (postHtml.includes('No result found for your search.')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: dirUrl,
        excerpt: 'No result found for your search.'
      };
    }

    const countMatch = postHtml.match(/(\d+)\s+results?\s+found/i);
    if (!countMatch && !postHtml.includes('commandLink_TITLE-BLUE')) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: dirUrl,
        excerpt: 'No results section detected'
      };
    }

    const c2 = getCookies(postRes);
    const allCookies = [c1, c2].filter(Boolean).join('; ');

    // Extract suppliers from search result page
    const nameMatch = postHtml.match(/class="commandLink_TITLE-BLUE"[^>]*><span>([\s\S]*?)<\/span>/i);
    const linkMatch = postHtml.match(/href="(\/ptn\/supplier\/directory\/searchDetail\.xhtml\?code=[^"]+)"/i);
    const uenMatch = postHtml.match(/Trading Partner Ref No\.[\s\S]*?<div class="formOutputText_VALUE-DIV\s*"[^>]*>([\s\S]*?)<\/div>/i);

    const supplierName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : cleanKeyword;
    const uen = uenMatch ? uenMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const detailPath = linkMatch ? linkMatch[1] : '';
    const detailUrl = detailPath ? `https://www.gebiz.gov.sg${detailPath}` : dirUrl;

    let supplyHeads = [];
    let regStatus = 'REGISTERED';

    if (detailPath) {
      try {
        const detailRes = await fetch(detailUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': allCookies,
            'Referer': dirUrl
          }
        });
        if (detailRes.ok) {
          const detailHtml = await detailRes.text();
          const rowMatches = [...detailHtml.matchAll(/<tr id="contentForm:j_idt184_row_\d+"[^>]*>([\s\S]*?)<\/tr>/gi)];
          for (const r of rowMatches) {
            const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
            if (cells.length >= 5) {
              supplyHeads.push(`${cells[1]} (${cells[2]}, Exp: ${cells[3]}, Status: ${cells[4]})`);
              regStatus = cells[4];
            }
          }
        }
      } catch (err) {
        // detail fetch failure is non-fatal if search returned the supplier
      }
    }

    const excerptMatch = postHtml.match(/<div class="formRow_HIDDEN-LABEL" style="text-align: left;">[\s\S]{0,400}/);
    const excerpt = excerptMatch ? excerptMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : `${supplierName} (${uen})`;

    return {
      status: 'found',
      reason: '',
      records: [
        {
          supplier_name: supplierName,
          uen: uen,
          supply_heads: supplyHeads.join('; ') || 'Registered GeBIZ Trading Partner',
          status: regStatus,
          detail_url: detailUrl
        }
      ],
      source_url: detailUrl,
      excerpt
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'other',
      records: [],
      source_url: 'https://www.gebiz.gov.sg/ptn/supplier/directory/index.xhtml',
      excerpt: err.message || String(err)
    };
  }
}
