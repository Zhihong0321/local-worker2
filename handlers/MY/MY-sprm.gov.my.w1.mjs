export const meta = {
  task: 'MY-sprm.gov.my',
  want: 'w1',
  tier: 2,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'role', 'id_no', 'gender', 'citizenship', 'state', 'category', 'employer', 'occupation', 'sentence_date', 'prosecutor', 'defence', 'cases', 'record_id'],
  canary: { found: 'Remarkable Trading Sdn Bhd', not_found: 'Syarikat Tiada Rekod Sdn Bhd' },
};

// Pangkalan Data Pesalah Rasuah (MACC conviction list). A GET keyword search returns an HTML list of 8 cards per page.
// Each card's modal holds the accused (Tertuduh) and the employer (Majikan), which is the company field.
const BASE = 'https://www.sprm.gov.my/index.php';
const PAGE_ID = '96';
const PER_PAGE = 8;        // the site ignores any other page size
const MAX_PAGES = 15;      // at most 120 hits read
const DEADLINE_MS = 50000; // keep the whole call under the 60 s limit
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<br\s*\/?>/gi, ' ; ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Company key: case, punctuation, spacing and legal-form spelling ignored (Berhad = Bhd). */
function keyOf(name) {
  return String(name || '').normalize('NFKC').toUpperCase().replace(/BERHAD/g, 'BHD').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Words sent to the site's search: the typed name with punctuation turned into spaces. */
function searchTerm(name) {
  return String(name || '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function searchUrl(term, page) {
  const u = new URL(BASE);
  u.searchParams.set('id', '21');
  u.searchParams.set('page_id', PAGE_ID);
  u.searchParams.set('keyword', term);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function get(url) {
  return fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-GB,en;q=0.8,ms;q=0.6',
    },
    signal: AbortSignal.timeout(25000),
  });
}

function parseSummary(html) {
  const m = html.match(/Showing\s*<b>\s*(\d+)\s*-\s*(\d+)\s*<\/b>\s*of\s*<b>\s*(\d+)\s*<\/b>\s*items?/i);
  return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
}

/** One card per hit: returns { record_id, fields: {label: value}, cases: [...] } */
function parseCards(html) {
  const parts = html.split('<div class="col-md-3 div-pesalah"').slice(1);
  return parts.map((part) => {
    // cut off whatever follows this card's modal (the next page block, scripts, styles)
    let block = part;
    for (const stop of ['<style', '<script']) {
      const i = block.indexOf(stop);
      if (i >= 0) block = block.slice(0, i);
    }
    const idMatch = part.match(/^[^>]*data-key="(\d+)"/);
    const fields = {};
    const rowRe = /<tr>\s*<td[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let r;
    while ((r = rowRe.exec(block)) !== null) {
      const label = cleanText(r[1]);
      if (!(label in fields)) fields[label] = cleanText(r[2]);
    }
    const cases = [];
    const tbody = block.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    if (tbody) {
      const trs = tbody[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (const tr of trs) {
        const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => cleanText(c.replace(/^<td[^>]*>|<\/td>$/gi, '')));
        if (cells.length >= 5) {
          cases.push({ no: cells[1], summary: cells[2], offence: cells[3], sentence: cells[4] });
        }
      }
    }
    return { record_id: idMatch ? idMatch[1] : '', fields, cases };
  });
}

/** Classifies one results page: 'list' (with summary and cards), 'empty', 'blocked' or 'layout'. */
function readPage(html) {
  if (!/PANGKALAN DATA PESALAH RASUAH/i.test(html)) {
    if (/captcha|access denied|are you a robot|just a moment/i.test(html)) return { kind: 'blocked' };
    return { kind: 'layout' };
  }
  const summary = parseSummary(html);
  if (!summary) {
    if (/No results found/i.test(html)) return { kind: 'empty' };
    return { kind: 'layout' };
  }
  const cards = parseCards(html);
  if (cards.length === 0 && summary.total > 0) return { kind: 'layout' };
  return { kind: 'list', summary, cards };
}

function toRecords(cards, target) {
  const out = [];
  for (const c of cards) {
    const f = c.fields;
    const accusedKey = keyOf(f['Tertuduh']);
    const employerKey = keyOf(f['Majikan']);
    if (accusedKey !== target && employerKey !== target) continue;
    const dash = (v) => (v && v !== '-' ? v : '');
    out.push({
      role: accusedKey === target ? 'accused' : 'employer',
      name: f['Tertuduh'] || '',
      id_no: f['No Pengenalan Diri'] || '',
      gender: f['Jantina'] || '',
      citizenship: f['Warganegara'] || '',
      state: f['Negeri'] || '',
      category: f['Kategori'] || '',
      employer: dash(f['Majikan']),
      occupation: dash(f['Jawatan']),
      sentence_date: f['Tarikh Jatuh Hukuman'] || '',
      prosecutor: f['Timbalan Pendakwa Raya / Pegawai Pendakwa'] || '',
      defence: f['Peguam Bela'] || '',
      cases: c.cases,
      record_id: c.record_id,
    });
  }
  return out;
}

function couldnt(reason, source_url, excerpt, records = []) {
  return { status: 'couldnt_check', reason, records, source_url, excerpt: String(excerpt).slice(0, 300) };
}

function failureReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'other';
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const started = Date.now();
  const input = String(keyword || '').trim();
  const target = keyOf(input);
  if (!target) return couldnt('other', '', 'empty company name');

  // Search words: the name as typed first (keeps "&" and dots), then the name with punctuation removed.
  const terms = [...new Set([input.normalize('NFKC').replace(/\s+/g, ' ').trim(), searchTerm(input)].filter(Boolean))];

  let term = terms[0];
  let firstUrl = searchUrl(term, 1);
  try {
    let first = null;
    for (const t of terms) {
      term = t;
      firstUrl = searchUrl(t, 1);
      const res = await get(firstUrl);
      if (res.status === 403 || res.status === 429) return couldnt('blocked', firstUrl, `HTTP ${res.status}`);
      if (!res.ok) return couldnt('http_error', firstUrl, `HTTP ${res.status}`);
      first = readPage(await res.text());
      if (first.kind === 'blocked') return couldnt('blocked', firstUrl, 'bot check or captcha page');
      if (first.kind === 'layout') return couldnt('layout_changed', firstUrl, 'results page is not the expected list');
      if (first.kind === 'list') break;
    }
    if (first.kind === 'empty') {
      return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
        excerpt: `Site search for ${terms.map((t) => `"${t}"`).join(' and ')}: No results found.` };
    }

    const total = first.summary.total;
    const pages = Math.ceil(total / PER_PAGE);
    const seen = new Set();
    const matches = [];
    const addMatches = (cards) => {
      for (const rec of toRecords(cards, target)) {
        const id = rec.record_id || JSON.stringify(rec);
        if (seen.has(id)) continue;
        seen.add(id);
        matches.push(rec);
      }
    };
    addMatches(first.cards);

    let pagesRead = 1;
    let stopReason = '';
    let stopExcerpt = '';
    for (let p = 2; p <= pages; p++) {
      if (p > MAX_PAGES) { stopReason = 'other'; stopExcerpt = `only ${MAX_PAGES} of ${pages} result pages read`; break; }
      if (Date.now() - started > DEADLINE_MS) { stopReason = 'timeout'; stopExcerpt = `only ${pagesRead} of ${pages} result pages read before the time limit`; break; }
      let next;
      try {
        const r = await get(searchUrl(term, p));
        if (r.status === 403 || r.status === 429) { stopReason = 'blocked'; stopExcerpt = `HTTP ${r.status} on page ${p}`; break; }
        if (!r.ok) { stopReason = 'http_error'; stopExcerpt = `HTTP ${r.status} on page ${p}`; break; }
        next = readPage(await r.text());
      } catch (err) {
        stopReason = failureReason(err); stopExcerpt = `page ${p}: ${String(err?.message || err)}`; break;
      }
      if (next.kind !== 'list') { stopReason = next.kind === 'blocked' ? 'blocked' : 'layout_changed'; stopExcerpt = `page ${p} is not the expected list`; break; }
      addMatches(next.cards);
      pagesRead = p;
    }

    if (matches.length > 0) {
      const note = stopReason ? ` (partial: ${stopExcerpt})` : '';
      return {
        status: 'found', reason: '', records: matches, source_url: firstUrl,
        excerpt: `${matches.length} record(s) name "${input}" as accused or employer; search "${term}" has ${total} hit(s)${note}`.slice(0, 300),
      };
    }
    if (stopReason) return couldnt(stopReason, firstUrl, `no exact match in the pages read; ${stopExcerpt}`);
    return { status: 'not_found', reason: '', records: [], source_url: firstUrl,
      excerpt: `Site search for "${term}" read ${pagesRead} of ${pages} page(s) (${total} hit(s)); no record names "${input}" as accused or employer` };
  } catch (err) {
    return couldnt(failureReason(err), firstUrl, String(err?.message || err));
  }
}
