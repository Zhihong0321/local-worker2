// Global handler: SSL certificate expiry and issuer. Input is the company's website domain.
// Opens one TLS connection to port 443 from the worker PC and reads the certificate the server presents.
// An expired or untrusted certificate is still read and reported (the connection accepts it on purpose).
import tls from 'node:tls';

export const meta = {
  task: 'ALL-ssl',
  want: 'w1',
  tier: 1,
  method: 'tls',
  input: 'domain',
  host: 'tls',
  question: 'Who issued the website\'s SSL certificate, when does it expire, and does it cover the domain?',
  why_it_matters: 'An expired, soon-to-expire or mismatched certificate is a basic sign of how well a site is looked after, and the issuer and dates are hard facts.',
  source_name: 'The website\'s TLS certificate (port 443)',
  source_url: 'https://crt.sh/',
  fields: ['host', 'issuer', 'valid_from', 'valid_to', 'days_left', 'expired', 'trusted_chain', 'covers_host', 'names'],
  canary: { found: 'google.com', not_found: 'canary-no-such-domain.invalid' },
};

function hostOf(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  try { s = new URL('http://' + s).hostname; } catch { /* keep as typed */ }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function result(status, reason, records, excerpt, sourceUrl) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '') };
}

function connect(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; try { sock.destroy(); } catch { /* already closed */ } resolve(value); } };
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      try {
        const cert = sock.getPeerCertificate(false);
        if (!cert || !cert.valid_to) return finish({ ok: false, code: 'NO_CERTIFICATE' });
        let mismatch = null;
        try { mismatch = tls.checkServerIdentity(host, cert) ?? null; } catch { mismatch = null; }
        finish({ ok: true, cert, authorized: sock.authorized, authError: sock.authorizationError ? String(sock.authorizationError) : null, mismatch: mismatch ? String(mismatch.message ?? mismatch) : null, protocol: sock.getProtocol?.() ?? null });
      } catch (err) { finish({ ok: false, code: String(err?.code ?? err?.message ?? 'ERROR') }); }
    });
    sock.setTimeout(12000, () => finish({ ok: false, code: 'ETIMEDOUT' }));
    sock.on('error', (err) => finish({ ok: false, code: String(err?.code ?? err?.message ?? 'ERROR') }));
  });
}

const field = (o, k) => (Array.isArray(o?.[k]) ? o[k].join(', ') : o?.[k] ?? null);
const day = (d) => (Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : null);

export default async function lookup(keyword) {
  const host = hostOf(keyword);
  const source = host ? `https://crt.sh/?q=${host}` : 'https://crt.sh/';
  if (!host) return result('couldnt_check', 'keyword_not_a_domain', [], `The keyword "${String(keyword ?? '').slice(0, 80)}" is not a domain name, so no certificate was read.`, source);
  try {
    // The bare domain first; many sites only serve HTTPS on www.
    const tried = [];
    let hit = null;
    for (const name of [host, `www.${host}`]) {
      const got = await connect(name);
      if (got.ok) { hit = { name, ...got }; break; }
      tried.push(`${name}: ${got.code}`);
    }
    if (!hit) {
      const codes = tried.map((t) => t.split(': ')[1]);
      if (codes.every((c) => c === 'ENOTFOUND')) return result('not_found', 'domain_does_not_resolve', [], `${host} does not resolve, so there is no certificate to read (${tried.join('; ')}).`, source);
      if (codes.every((c) => c === 'ECONNREFUSED')) return result('not_found', 'no_https_on_443', [], `Nothing answers HTTPS on port 443 for ${host} or www.${host} (${tried.join('; ')}).`, source);
      return result('couldnt_check', 'connect_failed', [], `Could not read a certificate for ${host} (${tried.join('; ')}). This says nothing certain about the company.`, source);
    }
    const c = hit.cert;
    const from = Date.parse(c.valid_from);
    const to = Date.parse(c.valid_to);
    const daysLeft = Number.isFinite(to) ? Math.floor((to - Date.now()) / 86_400_000) : null;
    const names = String(c.subjectaltname ?? '').split(/,\s*/).map((n) => n.replace(/^DNS:/, '')).filter(Boolean);
    const rec = {
      host: hit.name,
      subject: field(c.subject, 'CN'),
      issuer_org: field(c.issuer, 'O'),
      issuer_name: field(c.issuer, 'CN'),
      valid_from: day(from),
      valid_to: day(to),
      days_left: daysLeft,
      expired: daysLeft !== null ? daysLeft < 0 : null,
      lifetime_days: Number.isFinite(from) && Number.isFinite(to) ? Math.round((to - from) / 86_400_000) : null,
      trusted_chain: hit.authorized,
      trust_error: hit.authError,
      covers_host: !hit.mismatch,
      mismatch: hit.mismatch,
      names: names.slice(0, 50),
      name_count: names.length,
      protocol: hit.protocol,
      fingerprint256: c.fingerprint256 ?? null,
    };
    const timing = daysLeft === null ? 'expiry date unreadable' : daysLeft < 0 ? `EXPIRED ${-daysLeft} days ago` : `${daysLeft} days left`;
    const lines = [
      `SSL certificate served by ${hit.name}:`,
      `Issuer: ${[rec.issuer_org, rec.issuer_name].filter(Boolean).join(' / ') || 'unknown'}`,
      `Valid ${rec.valid_from ?? '?'} to ${rec.valid_to ?? '?'} (${timing}${rec.lifetime_days ? `; ${rec.lifetime_days}-day certificate` : ''})`,
      `Trusted chain: ${hit.authorized ? 'yes' : `no (${hit.authError ?? 'unknown reason'})`}`,
      `Covers ${hit.name}: ${hit.mismatch ? `NO (${hit.mismatch})` : 'yes'}`,
      `Names on the certificate (${names.length}): ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}`,
    ];
    if (tried.length) lines.push(`Earlier attempt failed: ${tried.join('; ')}`);
    return result('found', null, [rec], lines.join('\n'), source);
  } catch (err) {
    return result('couldnt_check', 'handler_error', [], `The SSL handler hit an error: ${String(err?.message ?? err).slice(0, 200)}`, source);
  }
}
