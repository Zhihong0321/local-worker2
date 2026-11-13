export const meta = { task: 'CH-bvger.ch', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'case_number', 'ruling_date', 'leid'],
  canary: { found: 'Swisscom Mobile AG', not_found: 'Zwölfhundert Phantasie Holding AG' } };

// The court's decision database (Weblaw) is a search app. Its public search endpoint answers an anonymous POST
// (no login, no token). Each hit carries the decision text with the matching words.
const SEARCH_URL = 'https://bvger.weblaw.ch/api/.netlify/functions/searchQueryService';
const PAGE_URL = 'https://bvger.weblaw.ch/dashboard?guiLanguage=de&sort-field=relevance&sort-direction=relevance';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Normalise a name: no accents, lower case, only a-z 0-9 separated by single spaces. */
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}

function plain(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#x2F;/gi, '/')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Metadata maps arrive either as objects or as python-style strings; read one key from either. */
function meta1(map, key) {
  if (!map) return '';
  if (typeof map === 'object') {
    const v = map[key];
    return Array.isArray(v) ? String(v[0] || '') : String(v || '');
  }
  const m = String(map).match(new RegExp(`'${key}': \\[?'([^']*)'`));
  return m ? m[1] : '';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const kw = String(keyword || '').replace(/[.,;:()"']/g, ' ').replace(/\s+/g, ' ').trim();
  const kwNorm = norm(keyword);
  try {
    if (!kwNorm) {
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
               excerpt: 'the name has no Latin letters or digits to search for' };
    }
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://bvger.weblaw.ch',
        'Referer': PAGE_URL,
      },
      body: JSON.stringify({ queryString: kw, guiLanguage: 'de', aggs: { fields: ['panel', 'rulingType', 'language'], size: 5 } }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) {
      return { status: 'couldnt_check', reason: 'blocked', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'couldnt_check', reason: 'http_error', records: [], source_url: SEARCH_URL, excerpt: `HTTP ${res.status}` };
    }

    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!data || !Array.isArray(data.documents) || typeof data.totalNumberOfDocuments !== 'number') {
      return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: SEARCH_URL,
               excerpt: String(JSON.stringify(data) || '').slice(0, 300) };
    }

    const total = data.totalNumberOfDocuments;
    if (total === 0) {
      return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
               excerpt: `0 decisions match "${kw}"` };
    }

    // Keep only decisions whose text contains the whole normalised name (legal form included when typed).
    const records = [];
    for (const doc of data.documents) {
      const text = plain(doc.content);
      if ((' ' + norm(text) + ' ').includes(' ' + kwNorm + ' ')) {
        records.push({
          name: kw,
          case_number: meta1(doc.metadataKeywordTextMap, 'sortTitle'),
          ruling_date: meta1(doc.metadataDateMap, 'rulingDate').slice(0, 10),
          leid: String(doc.leid || ''),
          excerpt: text.slice(0, 300),
        });
      }
    }

    if (records.length > 0) {
      return { status: 'found', reason: '', records, source_url: PAGE_URL,
               excerpt: `${total} decisions match "${kw}"; ${records.length} of the first ${data.documents.length} name it. ${records[0].excerpt}` };
    }
    if (data.hasMoreResults) {
      // The name may sit beyond the first page of hits: do not claim it is absent.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: PAGE_URL,
               excerpt: `${total} decisions match "${kw}" but none of the first ${data.documents.length} names it; more pages not read` };
    }
    return { status: 'not_found', reason: '', records: [], source_url: PAGE_URL,
             excerpt: `${total} decisions match "${kw}", none names it` };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: SEARCH_URL,
             excerpt: String(err?.message || err).slice(0, 300) };
  }
}
