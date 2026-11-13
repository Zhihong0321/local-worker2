export const meta = { task: 'AE-dmcc.ae', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'licence_status', 'licence_address', 'directory_id', 'publishing_agreement', 'phone', 'email'],
  canary: { found: 'HAYAAT GLOBAL SFO FZCO', not_found: 'شركة زيتون الوهمية للتجارة ذ.م.م' } };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_URL = 'https://dmccsf.my.salesforce-sites.com/Business_directory_Page?initialWidth=1644&childId=pym-0';
const REMOTE_URL = 'https://dmccsf.my.salesforce-sites.com/apexremote';
const PAGE_SIZE = 100;
// Legal-form words: ignored when comparing names and when building the directory search text.
const LEGAL = new Set(['llc', 'ltd', 'limited', 'liability', 'company', 'co', 'fzco', 'fze', 'fz', 'llp', 'pjsc', 'sdn', 'bhd', 'dmcc', 'branch', 'est', 'establishment', 'dwc']);
const PUBLISH_ALL = 'Publish all details in DMCC online/printed content';

/** Compare key: lower case, punctuation and legal form removed, spaces removed. */
function nameKey(s) {
  return (s || '').toLowerCase().replace(/\./g, '').split(/[^\p{L}\p{N}]+/u).filter((t) => t && !LEGAL.has(t)).join('');
}

function cleanText(s) {
  return (s || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').replace(/(,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

/** The directory search text: the keyword as typed, without the legal-form words at either end. */
function searchText(keyword) {
  const words = keyword.trim().split(/\s+/).filter(Boolean);
  const core = words.filter((w) => !LEGAL.has(w.toLowerCase().replace(/\./g, '')));
  return (core.length ? core : words).join(' ');
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  let page = PAGE_URL;
  try {
    // Step 1: the directory page carries the Visualforce remoting tokens for its search action.
    const pageRes = await fetch(PAGE_URL, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8' }, signal: AbortSignal.timeout(25000) });
    if (pageRes.status === 403 || pageRes.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${pageRes.status}` };
    }
    if (!pageRes.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${pageRes.status}` };
    }
    const html = await pageRes.text();
    const m = html.match(/RemotingProviderImpl\((\{[\s\S]*?\})\)\);/);
    let cfg = null;
    try { cfg = m ? JSON.parse(m[1]) : null; } catch { cfg = null; }
    const act = cfg?.actions?.Business_directory_Controller?.ms?.find((x) => x.name === 'fetchBySearchValue');
    if (!act || !cfg.vf?.vid || !act.csrf || !act.authorization) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: html.slice(0, 300) };
    }

    // Step 2: the same search the page runs when a name is typed into its search box.
    const text = searchText(keyword);
    const body = {
      action: 'Business_directory_Controller', method: 'fetchBySearchValue', type: 'rpc', tid: 1,
      data: [{ pagesize: PAGE_SIZE, startIndex: 0, endIndex: PAGE_SIZE - 1, searchstr: text }],
      ctx: { csrf: act.csrf, vid: cfg.vf.vid, ns: '', ver: act.ver, authorization: act.authorization },
    };
    page = REMOTE_URL;
    const res = await fetch(REMOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Referer': PAGE_URL, 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: PAGE_URL, excerpt: `HTTP ${res.status}` };
    }
    let reply = null;
    try { reply = await res.json(); } catch { reply = null; }
    const r = Array.isArray(reply) ? reply[0] : null;
    if (!r || !r.result || !Array.isArray(r.result.resultData)) {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: PAGE_URL, excerpt: JSON.stringify(reply).slice(0, 300) };
    }
    if (r.statusCode !== 200 || r.type === 'exception') {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL, excerpt: JSON.stringify(r).slice(0, 300) };
    }

    const total = Number(r.result.count) || 0;
    const rows = r.result.resultData;
    const want = nameKey(keyword);
    const matches = rows.filter((x) => nameKey(x.Account_Name__c) === want);
    if (!matches.length) {
      if (total > rows.length) {
        // More companies match the search text than were compared; absence cannot be proven.
        return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
          excerpt: `search "${text}" returned ${total} companies; only the first ${rows.length} were compared` };
      }
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL, excerpt: `0 matching companies for "${text}"` };
    }

    const records = matches.map((x) => {
      const acct = x.Account__r || {};
      const agreement = acct.Publishing_agreement_for_BD__c || '';
      // The company's own publishing agreement decides whether its contact details may be shown.
      const showContacts = agreement === PUBLISH_ALL;
      return {
        name: x.Account_Name__c || '',
        licence_status: x.License_Status__c || '',
        licence_address: cleanText(x.License_Address__c),
        directory_id: x.Id || '',
        publishing_agreement: agreement,
        phone: showContacts ? (acct.Phone_BD__c || '') : '',
        email: showContacts ? (acct.Company_Official_Email_Address__c || '') : '',
      };
    });

    return { status: 'found', reason: '', records, source_url: PAGE_URL,
      excerpt: records.map((x) => `${x.name} | ${x.licence_status} | ${x.licence_address}`).join(' ;; ').slice(0, 500) };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'couldnt_check', reason: timeout ? 'timeout' : 'other', records: [], source_url: page,
      excerpt: String(err?.message || err).slice(0, 300) };
  }
}
