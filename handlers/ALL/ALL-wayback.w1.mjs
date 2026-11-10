// Global handler: Wayback Machine. Input is the company's website domain.
// Lists which years the home page was archived: the first and the latest successful capture, and every year in
// between, each with a link to the capture. It reads the archive's capture index only. It does not read the archived
// pages: the archive refuses uncached page reads with HTTP 429 (decided with the owner, 2026-11-11).
// Gathers only; it compares nothing.

export const meta = {
  task: 'ALL-wayback',
  want: 'w1',
  tier: 1,
  method: 'json_api',
  input: 'domain',
  host: 'web.archive.org',
  question: 'How long has this website existed in the Internet Archive, and in which years was it captured?',
  why_it_matters: 'The first capture shows how old the website really is, and gaps in the captures show years when it was down or not worth archiving. Each capture links to the archived page for anyone who wants to look.',
  source_name: 'Internet Archive Wayback Machine',
  source_url: 'https://web.archive.org/',
  fields: ['first_capture', 'latest_capture', 'years_captured', 'captures'],
  canary: { found: 'example.com', not_found: 'canary-no-such-domain.invalid' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function hostOf(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  try { s = new URL('http://' + s).hostname; } catch { /* keep as typed */ }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function result(status, reason, records, excerpt, sourceUrl) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '') };
}

async function cdx(name, extra) {
  try {
    const res = await fetch(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(name)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200${extra}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let rows;
    try { rows = JSON.parse(await res.text()); } catch { return { ok: false, error: 'answer was not JSON' }; }
    return { ok: true, rows: Array.isArray(rows) ? rows.slice(1).filter((r) => Array.isArray(r) && /^\d{14}$/.test(r[0])) : [] };
  } catch (err) { return { ok: false, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? err).slice(0, 120) }; }
}

const stamp = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
const link = (r) => `https://web.archive.org/web/${r[0]}/${r[1]}`;

export default async function lookup(keyword) {
  const host = hostOf(keyword);
  const source = host ? `https://web.archive.org/web/*/${host}` : 'https://web.archive.org/';
  if (!host) return result('couldnt_check', 'keyword_not_a_domain', [], `The keyword "${String(keyword ?? '').slice(0, 80)}" is not a domain name, so the Wayback Machine was not asked.`, source);
  try {
    // One capture per year, successful captures only. The bare domain first, then www.
    let yearly = null;
    let usedHost = host;
    const errors = [];
    for (const name of [host, `www.${host}`]) {
      const res = await cdx(name, '&collapse=timestamp:4');
      if (!res.ok) { errors.push(`${name}: ${res.error}`); continue; }
      if (res.rows.length) { yearly = res.rows; usedHost = name; break; }
    }
    if (!yearly) {
      if (errors.length) return result('couldnt_check', 'archive_unreachable', [], `The Wayback Machine could not be read for ${host} (${errors.join('; ')}). This says nothing about the company.`, source);
      return result('not_found', 'never_archived', [], `The Wayback Machine holds no successful capture of ${host} or www.${host}.`, source);
    }

    // The latest capture of all (the yearly list only shows the first capture of each year). If this call fails the
    // newest yearly row stands in for it.
    const last = await cdx(usedHost, '&limit=-1');
    const latest = last.ok && last.rows.length ? last.rows[last.rows.length - 1] : yearly[yearly.length - 1];

    const first = yearly[0];
    const years = yearly.map((r) => r[0].slice(0, 4));
    const span = Number(latest[0].slice(0, 4)) - Number(first[0].slice(0, 4)) + 1;
    const missing = [];
    for (let y = Number(first[0].slice(0, 4)); y <= Number(latest[0].slice(0, 4)); y++) if (!years.includes(String(y))) missing.push(String(y));

    const rec = {
      domain: usedHost,
      first_capture: stamp(first[0]),
      first_capture_url: link(first),
      latest_capture: stamp(latest[0]),
      latest_capture_url: link(latest),
      years_captured: years,
      years_without_capture: missing,
      captures: yearly.map((r) => ({ date: stamp(r[0]), url: link(r) })),
    };
    const lines = [
      `Internet Archive for ${usedHost}: first successful capture ${rec.first_capture}, latest ${rec.latest_capture}; captured in ${years.length} of the ${span} years from ${years[0]} to ${latest[0].slice(0, 4)}.`,
      `Years with a capture: ${years.join(', ')}`,
      missing.length ? `Years in that span with no capture: ${missing.join(', ')}` : 'No year in that span is missing.',
      `First capture: ${rec.first_capture_url}`,
      `Latest capture: ${rec.latest_capture_url}`,
      'Only the archive\'s capture list was read; the archived pages themselves were not.',
    ];
    if (!last.ok) lines.push(`The latest capture could not be confirmed (${last.error}); the newest year's first capture is shown instead.`);
    return result('found', null, [rec], lines.join('\n'), source);
  } catch (err) {
    return result('couldnt_check', 'handler_error', [], `The Wayback handler hit an error: ${String(err?.message ?? err).slice(0, 200)}`, source);
  }
}
