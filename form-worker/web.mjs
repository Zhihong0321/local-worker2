// Reading one public web page, the way the hub's getPage does (agy-lab/src/country/country-industry-research.mjs):
// public addresses only, up to four redirects followed by hand, 12 seconds, HTML only, 5 MB at most.
import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'CountryIndustryResearch/1.0 (public business contact research)';
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 5_000_000;

function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return !(s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('::ffff:'));
  }
  return false;
}

async function validateUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('unsupported website URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('non-public website');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error('website resolves to a non-public address');
  return u;
}

/** One HTML page: { url, html }. Throws with a short reason when the page cannot be read. */
export async function getPage(url) {
  let current = url;
  for (let i = 0; i < 4; i++) {
    await validateUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const to = res.headers.get('location');
      if (!to) throw new Error('redirect without location');
      current = new URL(to, current).href;
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') || '')) throw new Error('not an HTML page');
    if (!res.body) return { url: current, html: '' };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) throw new Error('page too large');
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return { url: current, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('too many redirects');
}

/** The lead's website as a fetchable URL, or null when it is a social page, a listing or a link shortener. */
const NOT_OWN_SITE = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|wa\.me|whatsapp\.com|linktr\.ee|tiktok\.com|shopee\.com\.my|shopee\.com|lazada\.com\.my|lazada\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|business\.site|google\.com|goo\.gl|g\.page|bit\.ly|mudah\.my|carousell\.com\.my|grab\.com|foodpanda\.my|beacons\.ai|linkin\.bio|taplink\.cc)$/i;

export function ownSiteUrl(website) {
  const raw = String(website ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return null;
  if (NOT_OWN_SITE.test(url.hostname.replace(/^www\./i, ''))) return null;
  return url.toString();
}
