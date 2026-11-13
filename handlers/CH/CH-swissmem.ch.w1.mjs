export const meta = {
  task: 'CH-swissmem.ch',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  pdf: false,
  input: 'company name',
  fields: ['name', 'name_extension', 'address', 'address_extension', 'zip', 'city', 'phone', 'website', 'badges'],
  canary: { found: 'Georg Fischer AG', not_found: 'Blaubergerfeld Präzisionsmechanik GmbH' },
};

// Public member directory. Its "Firma oder Ort" search is a form POST (the same request the page's own JavaScript sends).
// The form's hidden fields (TYPO3 tokens) are read fresh from the directory page on every lookup.
const DIRECTORY_URL = 'https://www.swissmem.ch/de/mehrwert-fuer-ihr-unternehmen/mitgliederverzeichnis.html';
const PREFIX = 'tx_swissmemmembers_companylist';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,en;q=0.7',
};
const NO_RESULTS = 'Keine Resultate gefunden';
const BLOCK_HINT = /cf-chl|just a moment|access denied|verify you are human|captcha-challenge/i;
// Legal forms: removed from the end of a name before two names are compared.
const LEGAL_FORMS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'ltd', 'inc', 'llc', 'kg', 'kgaa', 'se', 'plc', 'sagl', 'srl', 'ug', 'ohg', 'ab', 'bv', 'spa']);
const LEGAL_TAIL = /(?:[\s,.]+(?:AG|GmbH|SA|S\.A\.|Sàrl|Sarl|Ltd\.?|Inc\.?|LLC|KG|SE|SAGL|SRL))+[\s,.]*$/i;

function decode(s) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = named[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Case, accents, punctuation and trailing legal form removed: "Stöckli AG" and "stockli gmbh" -> "stockli". */
function normalise(name) {
  const parts = decode(name).normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  while (parts.length && LEGAL_FORMS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** Attribute value from a tag's attribute text (which starts with a space or is the attribute list itself). */
function attr(text, name) {
  const m = (' ' + text).match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function stripTags(html) {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseCards(html) {
  const starts = [...html.matchAll(/<div class="members-result-card"([^>]*)>/g)];
  return starts.map((m, i) => {
    const block = html.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const asm = block.match(/class="members-asm"[^>]*>([\s\S]*?)<\/div>/);
    return {
      name: attr(m[1], 'data-name'),
      name_extension: attr(m[1], 'data-name-extension'),
      address: attr(m[1], 'data-address'),
      address_extension: attr(m[1], 'data-address-extension'),
      zip: attr(m[1], 'data-zip'),
      city: attr(m[1], 'data-city'),
      phone: attr(m[1], 'data-phone'),
      website: attr(m[1], 'data-url'),
      badges: asm ? [stripTags(asm[1])] : [],
    };
  });
}

function out(status, reason, source_url, excerpt, records = []) {
  return { status, reason, records, source_url, excerpt: String(excerpt).slice(0, 500) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const input = String(keyword || '').trim();
  const term = input.replace(LEGAL_TAIL, '').trim() || input;
  try {
    // 1. Directory page: the search form, its action URL and its hidden fields.
    const res = await fetch(DIRECTORY_URL, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (res.status === 403 || res.status === 429) return out('couldnt_check', 'blocked', DIRECTORY_URL, `HTTP ${res.status}`);
    if (!res.ok) return out('couldnt_check', 'http_error', DIRECTORY_URL, `HTTP ${res.status}`);
    const pageHtml = await res.text();
    const form = pageHtml.match(/<form\b([^>]*\bid="ajaxCompanySearch"[^>]*)>([\s\S]*?)<\/form>/i);
    if (!form) {
      if (BLOCK_HINT.test(pageHtml)) return out('couldnt_check', 'blocked', DIRECTORY_URL, 'bot check on the directory page');
      return out('couldnt_check', 'layout_changed', DIRECTORY_URL, 'company search form not found: ' + pageHtml.slice(0, 200));
    }
    const action = attr(form[1], 'action');
    if (!action) return out('couldnt_check', 'layout_changed', DIRECTORY_URL, 'search form has no action');

    const body = new URLSearchParams();
    for (const im of form[2].matchAll(/<input\b([^>]*)>/gi)) {
      if (attr(im[1], 'type').toLowerCase() !== 'hidden') continue;
      const name = attr(im[1], 'name');
      if (name) body.append(name, attr(im[1], 'value'));
    }
    if (!body.has(`${PREFIX}[__trustedProperties]`)) {
      return out('couldnt_check', 'layout_changed', DIRECTORY_URL, 'search form has no hidden token fields');
    }
    body.set(`${PREFIX}[search-word]`, term);
    body.set(`${PREFIX}[canton]`, 'all');
    body.set(`${PREFIX}[letter]`, 'all');

    // 2. The search request, exactly as the page's own script sends it.
    const postUrl = new URL(action, DIRECTORY_URL).href;
    const pr = await fetch(postUrl, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html, */*; q=0.01',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25000),
    });
    if (pr.status === 403 || pr.status === 429) return out('couldnt_check', 'blocked', DIRECTORY_URL, `HTTP ${pr.status}`);
    if (!pr.ok) return out('couldnt_check', 'http_error', DIRECTORY_URL, `HTTP ${pr.status}`);
    const html = await pr.text();

    const cards = parseCards(html);
    if (cards.length === 0) {
      if (html.includes(NO_RESULTS)) {
        return out('not_found', '', DIRECTORY_URL, `Swissmem member directory: "${NO_RESULTS}" for "${term}"`);
      }
      if (BLOCK_HINT.test(html)) return out('couldnt_check', 'blocked', DIRECTORY_URL, 'bot check on the search response');
      return out('couldnt_check', 'layout_changed', DIRECTORY_URL, 'search response has neither results nor the no-results text: ' + html.slice(0, 200));
    }

    // 3. Match the company by normalised name, not by similar words.
    const want = normalise(input);
    const matches = want ? cards.filter((c) => normalise(c.name) === want) : [];
    if (matches.length === 0) {
      const near = cards.slice(0, 5).map((c) => c.name).join('; ');
      return out('not_found', '', DIRECTORY_URL,
        `Swissmem member directory: ${cards.length} result(s) for "${term}", none with this name (e.g. ${near})`);
    }
    const records = matches.map((c) => ({ ...c }));
    const summary = records.map((r) => [r.name, r.address, r.zip, r.city].filter(Boolean).join(', ')).join(' | ');
    return out('found', '', DIRECTORY_URL,
      `Swissmem member directory: ${records.length} match(es) for "${term}": ${summary}`, records);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return out('couldnt_check', timeout ? 'timeout' : 'other', DIRECTORY_URL, String(err?.message || err).slice(0, 300));
  }
}
