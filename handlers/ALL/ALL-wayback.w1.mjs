// Global handler: Wayback Machine. Input is the company's website domain.
// Lists which years the home page was archived and keeps the opening text of a few old snapshots, so a later step
// can compare what the company claimed then with what it claims now. This handler only gathers; it compares nothing.

export const meta = {
  task: 'ALL-wayback',
  want: 'w1',
  tier: 1,
  method: 'json_api',
  input: 'domain',
  host: 'web.archive.org',
  question: 'How long has this website existed in the Internet Archive, and what did its home page say in earlier years?',
  why_it_matters: 'Old snapshots show when the site first appeared and let claims such as staff numbers, project counts or awards be checked against what the company said before.',
  source_name: 'Internet Archive Wayback Machine',
  source_url: 'https://web.archive.org/',
  fields: ['first_snapshot', 'last_snapshot', 'years_archived', 'snapshots'],
  canary: { found: 'example.com', not_found: 'canary-no-such-domain.invalid' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const TEXT_CHARS = 1500;
const BUDGET_MS = 110_000;

function hostOf(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  try { s = new URL('http://' + s).hostname; } catch { /* keep as typed */ }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function result(status, reason, records, excerpt, sourceUrl) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '') };
}

async function get(url, timeoutMs) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) { return { ok: false, error: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? err).slice(0, 120) }; }
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : m));

function pageText(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const desc = decode((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const body = decode(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return { title, description: desc, text: body.slice(0, TEXT_CHARS) };
}

const stamp = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

export default async function lookup(keyword) {
  const host = hostOf(keyword);
  const source = host ? `https://web.archive.org/web/*/${host}` : 'https://web.archive.org/';
  if (!host) return result('couldnt_check', 'keyword_not_a_domain', [], `The keyword "${String(keyword ?? '').slice(0, 80)}" is not a domain name, so the Wayback Machine was not asked.`, source);
  const started = Date.now();
  try {
    // One snapshot per year, successful captures only. The bare domain first, then www.
    let yearly = null;
    let usedHost = host;
    const errors = [];
    for (const name of [host, `www.${host}`]) {
      const res = await get(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(name)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&collapse=timestamp:4`, 30_000);
      if (!res.ok) { errors.push(`${name}: ${res.error}`); continue; }
      let rows;
      try { rows = JSON.parse(res.text); } catch { errors.push(`${name}: answer was not JSON`); continue; }
      const data = Array.isArray(rows) ? rows.slice(1).filter((r) => Array.isArray(r) && /^\d{14}$/.test(r[0])) : [];
      if (data.length) { yearly = data; usedHost = name; break; }
    }
    if (!yearly) {
      if (errors.length) return result('couldnt_check', 'archive_unreachable', [], `The Wayback Machine could not be read for ${host} (${errors.join('; ')}). This says nothing about the company.`, source);
      return result('not_found', 'never_archived', [], `The Wayback Machine holds no successful capture of ${host} or www.${host}.`, source);
    }

    const years = yearly.map((r) => r[0].slice(0, 4));
    const first = yearly[0];
    // Which snapshots to read: the oldest, about three years back, about one year back.
    const target = (yearsBack) => {
      const want = new Date().getUTCFullYear() - yearsBack;
      return [...yearly].sort((a, b) => Math.abs(Number(a[0].slice(0, 4)) - want) - Math.abs(Number(b[0].slice(0, 4)) - want))[0];
    };
    const picks = [];
    for (const row of [first, target(3), target(1)]) if (row && !picks.some((p) => p[0].slice(0, 4) === row[0].slice(0, 4))) picks.push(row);
    picks.sort((a, b) => a[0].localeCompare(b[0]));

    const snapshots = [];
    for (const row of picks) {
      const base = { timestamp: row[0], date: stamp(row[0]), url: `https://web.archive.org/web/${row[0]}/${row[1]}` };
      if (Date.now() - started > BUDGET_MS) { snapshots.push({ ...base, error: 'skipped: time budget used up' }); continue; }
      const page = await get(`https://web.archive.org/web/${row[0]}id_/${row[1]}`, 25_000);
      if (!page.ok) { snapshots.push({ ...base, error: page.error }); continue; }
      snapshots.push({ ...base, ...pageText(page.text) });
    }

    const rec = { domain: usedHost, first_snapshot: stamp(first[0]), last_snapshot_year: years[years.length - 1], years_archived: years, snapshots };
    const lines = [
      `Internet Archive for ${usedHost}: first successful capture ${stamp(first[0])}; captured in ${years.length} different years (${years[0]} to ${years[years.length - 1]}).`,
      `Years with a capture: ${years.join(', ')}`,
    ];
    for (const s of snapshots) {
      lines.push(s.error ? `Snapshot ${s.date} (${s.url}): could not be read (${s.error})`
        : `Snapshot ${s.date} (${s.url})\n  Title: ${s.title || '(none)'}${s.description ? `\n  Description: ${s.description}` : ''}\n  Opening text: ${s.text || '(no text found)'}`);
    }
    return result('found', null, [rec], lines.join('\n'), source);
  } catch (err) {
    return result('couldnt_check', 'handler_error', [], `The Wayback handler hit an error: ${String(err?.message ?? err).slice(0, 200)}`, source);
  }
}
