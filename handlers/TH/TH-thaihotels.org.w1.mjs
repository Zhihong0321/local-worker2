export const meta = { task: 'TH-thaihotels.org', want: 'w1', tier: 1, method: 'static_list', pdf: false, input: 'company name',
  fields: ['name', 'category', 'province', 'source_url'],
  canary: { found: 'AYUTTHAYA GRAND HOTEL', not_found: 'ZZQX NOT LISTED TRADING CO LTD' } };

// THA member directory: static list pages (no search request needed). Each page is one region or membership category.
const INDEX = 'https://www.thaihotels.org/16750708/memberlist';
const PAGES = [
  { category: 'Bangkok', url: 'https://www.thaihotels.org/16779801/bangkok' },
  { category: 'Central', url: 'https://www.thaihotels.org/16779802/central' },
  { category: 'Eastern', url: 'https://www.thaihotels.org/16779804/eastern' },
  { category: 'Western', url: 'https://www.thaihotels.org/16779805/western' },
  { category: 'Northern Upper', url: 'https://www.thaihotels.org/16779806/northern-upper' },
  { category: 'Northern Lower', url: 'https://www.thaihotels.org/16779823/northern-lower' },
  { category: 'Northeastern Upper', url: 'https://www.thaihotels.org/16779810/northeastern-upper' },
  { category: 'Northeastern Lower', url: 'https://www.thaihotels.org/16779807/northeastern-lower' },
  { category: 'Southern', url: 'https://www.thaihotels.org/16779827/southern' },
  { category: 'Southeastern', url: 'https://www.thaihotels.org/16779825/southeastern' },
  { category: 'Associate', url: 'https://www.thaihotels.org/16863553/associate' },
  { category: 'Extra Ordinary', url: 'https://www.thaihotels.org/17131004/extra-ordinary' },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Normalised name: case, punctuation, spaces and legal-form words removed. */
function norm(s) {
  return String(s).toLowerCase()
    .replace(/\(มหาชน\)|มหาชน|บริษัท|จำกัด/g, ' ')
    .replace(/[.,()\-\/&'"]/g, ' ')
    .replace(/\b(co|company|ltd|limited|plc|inc|pte|public|sdn|bhd|llc|corp|corporation)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/** Visible text pieces of the member list area, one per line/cell, in page order. */
function items(html) {
  let seg = html;
  const at = seg.indexOf('class="hidable-container"');
  if (at >= 0) seg = seg.slice(at);
  // The Bangkok page lists its child regions after its own table; those previews are not its members.
  const sub = seg.indexOf('class="subpages"');
  if (sub > 0) seg = seg.slice(0, sub);
  const end = seg.indexOf('Copyright');
  if (end > 0) seg = seg.slice(0, end);
  seg = seg.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '\n');
  return decode(seg).split('\n').map((s) => s.trim()).filter(Boolean);
}

async function fetchPage(page) {
  const res = await fetch(page.url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
  return { page, html: await res.text() };
}

function classify(err) {
  if (err && (err.status === 403 || err.status === 429)) return { reason: 'blocked', excerpt: 'HTTP ' + err.status };
  if (err && err.status) return { reason: 'http_error', excerpt: 'HTTP ' + err.status };
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { reason: 'timeout', excerpt: 'page did not answer in 25 s' };
  return { reason: 'other', excerpt: String(err && err.message || err).slice(0, 200) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kw = String(keyword || '').trim();
    if (/[฀-๿]/.test(kw)) {
      // The directory lists names in English only, so a Thai-script name cannot be matched and absence is not proven.
      return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX,
        excerpt: 'Thai-script name: the THA member list is in English only, so it cannot be matched' };
    }
    const key = norm(kw);
    if (!key) return { status: 'couldnt_check', reason: 'other', records: [], source_url: INDEX, excerpt: 'empty name' };

    const settled = await Promise.allSettled(PAGES.map(fetchPage));
    const records = [];
    const seen = new Set();
    let checked = 0;
    let failure = null;
    for (const r of settled) {
      if (r.status === 'rejected') { if (!failure) failure = r.reason; continue; }
      const { page, html } = r.value;
      const its = items(html);
      if (its.length === 0) { if (!failure) failure = Object.assign(new Error('no list text'), { layout: true }); continue; }
      checked++;
      for (let i = 0; i < its.length; i++) {
        if (norm(its[i]) !== key) continue;
        const province = its[i + 1] || '';
        const id = page.category + '|' + its[i] + '|' + province;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({ name: its[i], category: page.category, province, source_url: page.url });
      }
    }

    if (records.length) {
      const cats = [...new Set(records.map((x) => x.category))].join(', ');
      return { status: 'found', reason: '', records, source_url: records[0].source_url,
        excerpt: records.length + ' match(es) on the THA member list: ' + cats };
    }
    if (failure) {
      const c = failure.layout ? { reason: 'layout_changed', excerpt: 'list page has no member text' } : classify(failure);
      return { status: 'couldnt_check', reason: c.reason, records: [], source_url: INDEX,
        excerpt: 'a list page could not be read: ' + c.excerpt };
    }
    if (checked < PAGES.length) return { status: 'couldnt_check', reason: 'layout_changed', records: [], source_url: INDEX, excerpt: 'incomplete check' };
    return { status: 'not_found', reason: '', records: [], source_url: INDEX,
      excerpt: 'all ' + PAGES.length + ' THA member list pages were read; no entry matches' };
  } catch (err) {
    const c = classify(err);
    return { status: 'couldnt_check', reason: c.reason, records: [], source_url: INDEX, excerpt: c.excerpt };
  }
}
