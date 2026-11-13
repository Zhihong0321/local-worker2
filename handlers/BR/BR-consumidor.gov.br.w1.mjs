export const meta = {
  task: 'BR-consumidor.gov.br',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'base_name', 'status_note', 'site_id', 'subjects', 'profile_30d'],
  canary: { found: 'BANCO BRADESCO', not_found: 'EMPRESA INEXISTENTE TESTE LTDA' },
};

const BASE = 'https://www.consumidor.gov.br';
const SEARCH_URL = `${BASE}/pages/empresa/listarPorNome.json`;
const HOME_URL = `${BASE}/pages/principal/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEGAL_WORDS = new Set(['LTDA', 'LTD', 'ME', 'EPP', 'EIRELI', 'MEI', 'SA', 'CIA', 'LIMITADA', 'COMPANHIA']);

/** Upper-case ASCII, no accents, punctuation or legal-form words. Used for the search text and for comparing names. */
function normalize(str) {
  const s = String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\bS\s*[./]?\s*A\b\.?/g, ' SA ');
  return s.replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter((t) => t && !LEGAL_WORDS.has(t)).join(' ');
}

/** Listing label "X (DESATIVADA - ATUAL Y)" -> base name "X" and the note in brackets. */
function splitLabel(label) {
  const text = String(label || '').trim();
  const open = text.indexOf('(');
  if (open < 0) return { base: text, note: '' };
  const close = text.lastIndexOf(')');
  return { base: text.slice(0, open).trim(), note: text.slice(open + 1, close > open ? close : undefined).trim() };
}

/** Cookie header from the Set-Cookie headers of a response (the detail page needs the session from the search). */
function cookiesFrom(res) {
  let list;
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else list = (res.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
  return list.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

/** The site answers in ISO-8859-1; fall back to it when the bytes are not valid UTF-8. */
async function readText(res) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('iso-8859-1').decode(bytes);
  }
}

/** 30-day indicators of one company. Never throws: null when the detail cannot be read. */
async function fetchProfile(id, cookie) {
  if (!id) return null;
  try {
    const res = await fetch(`${BASE}/pages/empresa/${encodeURIComponent(id)}/aba/DIAS/periodo/30/perfil.json`, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;
    const j = JSON.parse(await readText(res));
    return {
      period: 'last 30 days',
      finalised_complaints: j.totalReclamacoes ?? null,
      solution_index_pct: j.indicadorSolucao ?? null,
      satisfaction_1_to_5: j.indicadorSatisfacaoAtendimento ?? null,
      responded_pct: j.indicadorReclamcoesRespondidas ?? null,
      avg_response_days: j.indicadorPrazoMedioRespostas ?? null,
      response_deadline_days: j.prazoResposta ?? null,
    };
  } catch {
    return null;
  }
}

function answer(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 500) };
}

async function lookupOnce(keyword) {
  const target = normalize(keyword);
  if (!target) return answer('couldnt_check', 'other', [], HOME_URL, 'no letters or digits in the company name');
  try {
    // The site's search box posts here. The WAF rejects non-ASCII text, so the query is sent without accents.
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': HOME_URL,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: `query=${encodeURIComponent(target)}`,
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 403 || res.status === 429) return answer('couldnt_check', 'blocked', [], SEARCH_URL, `HTTP ${res.status}`);
    if (!res.ok) return answer('couldnt_check', 'http_error', [], SEARCH_URL, `HTTP ${res.status}`);

    const cookie = cookiesFrom(res);
    const text = (await readText(res)).trim();
    if (!text.startsWith('[')) {
      if (/Request Rejected|captcha/i.test(text.slice(0, 2000))) return answer('couldnt_check', 'blocked', [], SEARCH_URL, text.slice(0, 300));
      return answer('couldnt_check', 'layout_changed', [], SEARCH_URL, text.slice(0, 300));
    }

    let items;
    try {
      items = JSON.parse(text);
    } catch {
      return answer('couldnt_check', 'layout_changed', [], SEARCH_URL, text.slice(0, 300));
    }
    if (!Array.isArray(items)) return answer('couldnt_check', 'layout_changed', [], SEARCH_URL, text.slice(0, 300));

    // value "-1" is the site's own "company not found" entry.
    const listed = items.filter((it) => it && it.label && it.value && String(it.value) !== '-1');
    const matches = listed.filter((it) => normalize(splitLabel(it.label).base) === target);
    if (matches.length === 0) {
      const shown = listed.slice(0, 5).map((it) => String(it.label).trim()).join(' | ');
      return answer('not_found', '', [], SEARCH_URL, `Site search returned ${listed.length} listing(s), none with this name. ${shown}`);
    }

    const profiles = await Promise.all(matches.map((m) => fetchProfile(m.value, cookie)));
    const records = matches.map((m, i) => {
      const { base, note } = splitLabel(m.label);
      return {
        name: String(m.label).trim(),
        base_name: base,
        status_note: note,
        site_id: m.value,
        subjects: m.assuntos || '',
        profile_30d: profiles[i],
      };
    });
    return answer(
      'found',
      '',
      records,
      `${BASE}/pages/empresa/${encodeURIComponent(matches[0].value)}/`,
      `Listed as: ${records.map((r) => r.name).join(' | ')}`,
    );
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return answer('couldnt_check', timeout ? 'timeout' : 'other', [], SEARCH_URL, String((err && err.message) || err));
  }
}

/**
 * Look one company up. Must never throw: every failure is a couldnt_check with a reason.
 * The short pause before returning lets the runtime finish closing the keep-alive sockets. Without it,
 * the runner's process.exit() aborts Node 24 on Windows (libuv assertion, exit 127) right after the answer.
 */
export default async function lookup(keyword) {
  const answerNow = await lookupOnce(keyword);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return answerNow;
}
