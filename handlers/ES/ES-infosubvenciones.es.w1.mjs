export const meta = { task: 'ES-infosubvenciones.es', want: 'w1', tier: 2, method: 'json_api', pdf: false, input: 'company name',
  fields: ['name', 'nif', 'tercero_id'],
  canary: { found: 'TELEFONICA I+D, S.A.U.', not_found: 'ZARXQUA DESARROLLOS FICTICIOS, S.L.' } };

// BDNS (Spain) public API. The portal's own front end calls GET /bdnstrans/api/terceros?vpd=GE&busqueda=<text>.
// It answers 200 with {"terceros":[{"id":..,"descripcion":"<NIF> - <NAME>"}, ...]}, or 204 with no body when nothing matches.
// It returns at most 150 entries per query.
const API = 'https://www.infosubvenciones.es/bdnstrans/api/terceros';
const CAP = 150;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL = new Set(['SA', 'SAU', 'SL', 'SLU', 'SLL', 'SLNE', 'SLP', 'SRL', 'SC', 'SCA', 'SCL', 'SCOOP', 'SAL', 'AIE', 'AIEE', 'UTE',
  'COOP', 'SOCIEDAD', 'ANONIMA', 'LIMITADA', 'UNIPERSONAL', 'COOPERATIVA']);

/** Upper-case, no accents, no dots or plus signs, punctuation as spaces. */
function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[+.]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Split a name into its core (legal form removed) and its legal-form tokens. */
function parts(s) {
  const t = fold(s).split(' ').filter(Boolean);
  return { core: t.filter((x) => !LEGAL.has(x)).join(''), legal: t.filter((x) => LEGAL.has(x)) };
}

function sameCompany(keyword, listed) {
  const k = parts(keyword);
  const c = parts(listed);
  if (!k.core || k.core !== c.core) return false;
  if (!k.legal.length || !c.legal.length) return true; // no legal form typed on one side: names agree
  const kIn = k.legal.every((x) => c.legal.includes(x));
  const cIn = c.legal.every((x) => k.legal.includes(x));
  return kIn || cIn;
}

/** The name as typed, with the legal-form words dropped, used as the site search text. */
function searchText(keyword) {
  const kept = (keyword || '').trim().split(/\s+/).map((w) => w.replace(/[.,;:]+$/, '')).filter((w) => {
    const w2 = fold(w);
    return w2 && !LEGAL.has(w2);
  });
  return (kept.join(' ') || keyword || '').trim();
}

function parseEntry(descripcion) {
  const text = String(descripcion || '');
  const i = text.indexOf(' - ');
  if (i < 0) return { nif: '', name: text.trim() };
  return { nif: text.slice(0, i).trim(), name: text.slice(i + 3).trim() };
}

async function search(text) {
  const url = `${API}?vpd=GE&busqueda=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) return { fail: { status: 'couldnt_check', reason: 'blocked', url, excerpt: `HTTP ${res.status}` } };
  if (res.status === 204) return { url, entries: [] };
  if (!res.ok) return { fail: { status: 'couldnt_check', reason: 'http_error', url, excerpt: `HTTP ${res.status}` } };
  const body = await res.text();
  if (!body.trim()) return { url, entries: [] };
  let json;
  try { json = JSON.parse(body); } catch {
    const blocked = /captcha|access denied|forbidden|robot|bot/i.test(body.slice(0, 2000));
    return { fail: { status: 'couldnt_check', reason: blocked ? 'blocked' : 'layout_changed', url, excerpt: body.slice(0, 300) } };
  }
  if (!json || !Array.isArray(json.terceros)) {
    return { fail: { status: 'couldnt_check', reason: 'layout_changed', url, excerpt: body.slice(0, 300) } };
  }
  return { url, entries: json.terceros };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const answer = await lookupOnce(keyword);
  // Node 24 on Windows aborts (exit 127) when the runner calls process.exit() right after a fetch whose socket is still
  // closing. A short pause lets the socket close first. It does not change the answer.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return answer;
}

async function lookupOnce(keyword) {
  let url = `${API}?vpd=GE&busqueda=`;
  try {
    const text = searchText(keyword);
    const queries = [text];
    if (keyword && keyword.trim() !== text) queries.push(keyword.trim());

    let capped = false;
    let total = 0;
    let lastUrl = '';
    for (const q of queries) {
      const r = await search(q);
      if (r.fail) return { status: r.fail.status, reason: r.fail.reason, records: [], source_url: r.fail.url, excerpt: r.fail.excerpt };
      lastUrl = r.url;
      url = r.url;
      total = r.entries.length;
      const seen = new Set();
      const matches = [];
      for (const e of r.entries) {
        const p = parseEntry(e.descripcion);
        if (!sameCompany(keyword, p.name)) continue;
        const key = `${e.id}|${p.nif}|${p.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ name: p.name, nif: p.nif, tercero_id: e.id });
      }
      if (matches.length) {
        return {
          status: 'found', reason: '', records: matches, source_url: r.url,
          excerpt: `${matches.length} matching beneficiary record(s) for "${keyword}" in ${r.entries.length} search result(s)`,
        };
      }
      capped = r.entries.length >= CAP;
      if (!capped) break; // this query listed everything it matched, so no need for the next one
    }

    if (capped) {
      return {
        status: 'couldnt_check', reason: 'other', records: [], source_url: lastUrl || url,
        excerpt: `the search returned ${CAP} results (the site cap) and none matched "${keyword}" exactly; cannot confirm`,
      };
    }
    return {
      status: 'not_found', reason: '', records: [], source_url: lastUrl || url,
      excerpt: `0 beneficiary records matched "${keyword}" (site returned ${total} result(s))`,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: 'couldnt_check', reason: timedOut ? 'timeout' : 'other', records: [], source_url: url,
      excerpt: String(err?.message || err).slice(0, 300),
    };
  }
}
