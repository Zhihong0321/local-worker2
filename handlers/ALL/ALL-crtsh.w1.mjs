// Global handler: Certificate Transparency logs (crt.sh). Input is the company's website domain.
// Every certificate ever issued for the domain or its subdomains is public. This lists the hostnames they show:
// forgotten sites, staging servers, old brands. crt.sh first; Cert Spotter's free endpoint if crt.sh is down.
// Gathers only: names, first-seen dates and issuers. Which name matters is for the later step.

export const meta = {
  task: 'ALL-crtsh',
  want: 'w1',
  tier: 1,
  method: 'json_api',
  input: 'domain',
  host: 'crt.sh',
  question: 'Which subdomains and hostnames have ever had a public SSL certificate under this domain, and since when?',
  why_it_matters: 'Certificate logs reveal forgotten sites, staging and test servers, old brands and how long the domain has been in real use, all without touching the company\'s systems.',
  source_name: 'Certificate Transparency logs (crt.sh)',
  source_url: 'https://crt.sh/',
  fields: ['hostnames', 'cert_count', 'first_seen', 'last_expiry', 'issuers', 'non_production_names'],
  canary: { found: 'example.org', not_found: 'canary-no-such-domain.invalid' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const WORDS = /(^|[.-])(dev|develop|staging|stage|stg|test|testing|uat|qa|demo|sandbox|old|new|beta|alpha|admin|vpn|intranet|internal|git|gitlab|jenkins|backup|bak|preprod|pre-prod|temp|tmp)(\d*)([.-]|$)/i;

function hostOf(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  try { s = new URL('http://' + s).hostname; } catch { /* keep as typed */ }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function result(status, reason, records, excerpt, sourceUrl) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries, timeoutMs) {
  let last = 'no attempt';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const text = await res.text();
        try { return { ok: true, data: JSON.parse(text) }; } catch { last = 'answer was not JSON'; }
      } else last = `HTTP ${res.status}`;
    } catch (err) { last = String(err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? err).slice(0, 120); }
    if (i < tries - 1) await sleep(3000);
  }
  return { ok: false, error: last };
}

const iso = (s) => { const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? s : `${s}Z`); return Number.isFinite(t) ? t : null; };
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');

export default async function lookup(keyword) {
  const host = hostOf(keyword);
  const source = host ? `https://crt.sh/?q=%25.${host}` : 'https://crt.sh/';
  if (!host) return result('couldnt_check', 'keyword_not_a_domain', [], `The keyword "${String(keyword ?? '').slice(0, 80)}" is not a domain name, so no certificate log was read.`, source);
  try {
    // rows: { names: string[], from: ms|null, to: ms|null, issuer: string|null }
    let rows = [];
    let via = 'crt.sh';
    let partial = false;
    const crt = await getJson(`https://crt.sh/?q=%25.${encodeURIComponent(host)}&output=json`, 3, 60_000);
    let failure = null;
    if (crt.ok && Array.isArray(crt.data)) {
      rows = crt.data.map((e) => ({ names: String(e.name_value ?? e.common_name ?? '').split(/\s+/).filter(Boolean), from: iso(e.not_before), to: iso(e.not_after), issuer: (String(e.issuer_name ?? '').match(/O=("[^"]*"|[^,]+)/)?.[1] ?? e.issuer_name ?? null)?.replace(/^"|"$/g, '') ?? null }));
    } else {
      failure = `crt.sh: ${crt.error ?? 'unexpected answer'}`;
      // Fallback: Cert Spotter's unauthenticated endpoint returns the first page only.
      const cs = await getJson(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(host)}&include_subdomains=true&expand=dns_names&expand=issuer`, 1, 40_000);
      if (cs.ok && Array.isArray(cs.data)) {
        via = 'Cert Spotter';
        partial = cs.data.length >= 100;
        rows = cs.data.map((e) => ({ names: Array.isArray(e.dns_names) ? e.dns_names : [], from: iso(e.not_before), to: iso(e.not_after), issuer: e.issuer?.friendly_name ?? e.issuer?.name ?? null }));
      } else failure += `; Cert Spotter: ${cs.error ?? 'unexpected answer'}`;
    }
    if (failure && via === 'crt.sh' && !(crt.ok && Array.isArray(crt.data))) {
      return result('couldnt_check', 'logs_unreachable', [], `Could not read the certificate logs for ${host} (${failure}). This says nothing about the company.`, source);
    }

    const byName = new Map();
    const issuers = new Map();
    for (const row of rows) {
      for (const raw of row.names) {
        const wildcard = raw.startsWith('*.');
        const name = raw.replace(/^\*\./, '').toLowerCase();
        if (name !== host && !name.endsWith(`.${host}`)) continue;
        const cur = byName.get(name) ?? { name, first_seen: null, last_expiry: null, certs: 0, wildcard: false };
        cur.certs++;
        cur.wildcard ||= wildcard;
        if (row.from && (!cur.first_seen || row.from < cur.first_seen)) cur.first_seen = row.from;
        if (row.to && (!cur.last_expiry || row.to > cur.last_expiry)) cur.last_expiry = row.to;
        byName.set(name, cur);
      }
      if (row.issuer) issuers.set(row.issuer, (issuers.get(row.issuer) ?? 0) + 1);
    }
    const list = [...byName.values()].sort((a, b) => (a.first_seen ?? Infinity) - (b.first_seen ?? Infinity) || a.name.localeCompare(b.name));
    if (!list.length) return result('not_found', 'no_certificates_logged', [], `No public certificate for ${host} or its subdomains was found in the logs (${via}).`, source);

    const hostnames = list.map((n) => ({ name: n.name, first_seen: day(n.first_seen), last_expiry: day(n.last_expiry), certs: n.certs, wildcard: n.wildcard }));
    const nonProd = hostnames.filter((n) => WORDS.test(n.name.slice(0, n.name.length - host.length - 1)));
    const earliest = Math.min(...list.map((n) => n.first_seen ?? Infinity));
    const latest = Math.max(...list.map((n) => n.last_expiry ?? -Infinity));
    const topIssuers = [...issuers].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n} (${c})`);
    const rec = { domain: host, via, partial, cert_rows: rows.length, hostname_count: hostnames.length, first_seen: day(Number.isFinite(earliest) ? earliest : null), last_expiry: day(Number.isFinite(latest) ? latest : null), issuers: topIssuers, non_production_names: nonProd.map((n) => n.name), hostnames: hostnames.slice(0, 300) };
    const lines = [
      `Certificate Transparency logs for ${host} (${via}${partial ? ', first page only, so the list may be incomplete' : ''}):`,
      `${hostnames.length} distinct hostnames across ${rows.length} certificate entries; first certificate ${rec.first_seen}, latest expiry ${rec.last_expiry}.`,
      `Issuers: ${topIssuers.join(', ') || 'unknown'}`,
      `Hostnames (first seen): ${hostnames.slice(0, 60).map((n) => `${n.name} (${n.first_seen})`).join(', ')}${hostnames.length > 60 ? `, ... and ${hostnames.length - 60} more` : ''}`,
      nonProd.length ? `Names containing a test/staging/old-style word: ${nonProd.slice(0, 25).map((n) => n.name).join(', ')}` : 'No hostname contains a test/staging/old-style word.',
    ];
    if (failure) lines.push(`Note: crt.sh failed (${failure.split(';')[0]}), so this comes from ${via}.`);
    return result('found', null, [rec], lines.join('\n'), source);
  } catch (err) {
    return result('couldnt_check', 'handler_error', [], `The certificate-log handler hit an error: ${String(err?.message ?? err).slice(0, 200)}`, source);
  }
}
