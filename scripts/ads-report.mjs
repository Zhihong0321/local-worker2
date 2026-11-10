// Turns an ads.research result into one plain HTML page, ad pictures included.
//   node scripts/ads-report.mjs <result.json> [out.html]
// The input is the JSON a job returns (the whole API answer, or just its result).
// Pictures are downloaded now and written into the page, because Meta's image links
// expire within days; one that cannot be downloaded keeps its remote link.
import fs from 'node:fs';

const [src, dest] = process.argv.slice(2);
if (!src) { console.error('usage: node scripts/ads-report.mjs <result.json> [out.html]'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const r = raw.job?.result ?? raw.result ?? raw;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const a = (href, label) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label));
const entries = (o) => Object.entries(o ?? {}).sort((x, y) => y[1] - x[1]);
const top = (o, n = 3) => entries(o).slice(0, n).map(([k]) => k).join(', ') || '-';
const days = (n) => (n == null ? '-' : n >= 60 ? `${Math.round(n / 30)} months` : `${n} days`);
const nice = (n) => (n == null ? '-' : Number(n).toLocaleString('en-GB'));
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-');
const cut = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n).trimEnd() + '…' : s; };
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const g = r.google ?? {};
const m = r.meta ?? {};
const metaAds = m.advertisers ?? [];
const about = metaAds.filter((x) => x.relevance !== 'unconfirmed')
  .sort((x, y) => y.adsSeen - x.adsSeen || (y.longestRunningDays ?? 0) - (x.longestRunningDays ?? 0));
const other = metaAds.filter((x) => x.relevance === 'unconfirmed');
const shown = about.flatMap((x) => x.sampleAds ?? []);

// ------------------------------------------------------------------ pictures

const urls = new Set();
for (const x of about) {
  if (x.pageImage) urls.add(x.pageImage);
  for (const ad of x.sampleAds ?? []) { if (ad.image) urls.add(ad.image); for (const c of ad.cards ?? []) if (c.image) urls.add(c.image); }
}
for (const x of g.advertisers ?? []) for (const ad of x.sampleAds ?? []) if (ad.format === 'image' && ad.previewUrl) urls.add(ad.previewUrl);
const pics = new Map();
async function download(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length <= 250_000) pics.set(url, `data:${type};base64,${bytes.toString('base64')}`);
  } catch { /* the remote link is kept */ }
}
const queue = [...urls];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await download(queue.shift()); }));
const pic = (url) => pics.get(url) ?? url;
console.error(`pictures: ${pics.size} of ${urls.size} saved into the page`);

// ------------------------------------------------------------------ one ad

const adCard = (ad) => {
  const text = String(ad.text ?? '');
  const e = ad.extracted ?? {};
  const body = text.length > 280
    ? `<div class="copy">${esc(cut(text, 280))}</div><details><summary>read it all</summary><div class="copy">${esc(text)}</div></details>`
    : text ? `<div class="copy">${esc(text)}</div>` : '';
  const picture = ad.image
    ? `<a href="${esc(ad.url)}" target="_blank" rel="noopener"><img src="${esc(pic(ad.image))}" alt="${esc(ad.headline ?? 'ad picture')}" loading="lazy"></a>`
    : '<div class="nopic">no picture in the library</div>';
  const extra = (ad.images ?? []).length > 1 ? ` · ${ad.images.length} pictures` : (ad.cards ?? []).length ? ` · carousel of ${ad.cards.length}` : '';
  const host = ad.domain && !/facebook|instagram|whatsapp|fb\.(me|com)/.test(ad.domain) ? ` · goes to ${esc(ad.domain)}` : ad.domain ? ` · goes to ${esc(ad.domain)}` : '';
  return `<div class="ad">
  <div class="pic">${picture}${ad.hasVideo ? '<span class="tag">video</span>' : ''}</div>
  <div class="txt">
    <div class="meta">${ad.active ? '<span class="pill">running</span> ' : 'ended · '}since ${esc(ad.start ?? '?')}${extra}${host}</div>
    ${ad.headline ? `<div class="head">${esc(cut(ad.headline, 140))}</div>` : ''}
    ${body}
    <div class="meta">${ad.cta ? `Button: <b>${esc(ad.cta)}</b> · ` : ''}${ad.byline ? `Paid for by ${esc(ad.byline)} · ` : ''}${[...(e.prices ?? []), ...(e.percents ?? [])].length ? `Numbers: ${esc([...(e.prices ?? []), ...(e.percents ?? [])].join(', '))} · ` : ''}${(e.phones ?? []).length ? `Phone: ${esc(e.phones.join(', '))} · ` : ''}${a(ad.url, 'open in Ad Library')}</div>
  </div>
</div>`;
};

const chips = (o, n = 8) => entries(o).slice(0, n).map(([k, v]) => `<span class="chip">${esc(k)}${v > 1 ? ` ×${v}` : ''}</span>`).join('') || '<span class="sub">none seen</span>';

const advertiserBlock = (x) => `<section class="adv" id="${esc(slug(x.pageName))}">
  <div class="advhead">
    ${x.pageImage ? `<img class="avatar" src="${esc(pic(x.pageImage))}" alt="">` : '<div class="avatar"></div>'}
    <div>
      <h3>${a(x.libraryUrl, x.pageName ?? 'unknown')}</h3>
      <div class="sub">${esc([...new Set(x.categories ?? [])].join(', '))}${x.likes != null ? ` · ${nice(x.likes)} page likes` : ''}${x.pageUrl ? ` · ${a(x.pageUrl, 'Facebook page')}` : ''}</div>
    </div>
  </div>
  <div class="facts">
    <div><b>${x.adsSeen}</b> ads seen<br><span class="sub">${x.activeAds} running now</span></div>
    <div><b>${days(x.longestRunningDays)}</b> oldest ad<br><span class="sub">first started ${esc(x.firstStarted ?? '?')}</span></div>
    <div><b>${x.startedLast30Days}</b> new in 30 days<br><span class="sub">latest ${esc(x.lastStarted ?? '?')}</span></div>
    <div><b>${pct(x.adsWithVideo, x.adsSeen)}</b> video<br><span class="sub">${esc(top(x.formats, 2).toLowerCase())}</span></div>
  </div>
  <div class="rows">
    <div><span class="k">Hooks in the copy</span>${chips(x.hooks)}</div>
    ${Object.keys(x.prices ?? {}).length || Object.keys(x.percents ?? {}).length ? `<div><span class="k">Prices and numbers</span>${chips({ ...x.prices, ...x.percents })}</div>` : ''}
    ${Object.keys(x.contacts ?? {}).length ? `<div><span class="k">Phone numbers</span>${chips(x.contacts)}</div>` : ''}
    <div><span class="k">Buttons</span>${chips(x.ctas)}</div>
    <div><span class="k">Language</span>${chips(x.languages)}<span class="k gap">Shown on</span>${chips(Object.fromEntries(Object.entries(x.platforms ?? {}).map(([k, v]) => [k.toLowerCase().replace('_', ' '), v])), 6)}</div>
    <div><span class="k">Sends people to</span>${chips(x.websites)}</div>
  </div>
  <div class="ads">${(x.sampleAds ?? []).map(adCard).join('')}</div>
  ${x.adsSeen > (x.sampleAds ?? []).length ? `<p class="sub">Showing ${(x.sampleAds ?? []).length} of ${x.adsSeen} ads seen: the three longest-running, then the newest. ${a(x.libraryUrl, 'All of this advertiser\'s ads in the library')}</p>` : ''}
</section>`;

// ------------------------------------------------------------------ what it adds up to

const tally = (pick) => { const t = {}; for (const x of about) for (const [k, v] of Object.entries(pick(x) ?? {})) t[k] = (t[k] ?? 0) + (typeof v === 'number' ? 1 : 1); return t; };
const adTotal = about.reduce((n, x) => n + x.adsSeen, 0);
const videoTotal = about.reduce((n, x) => n + x.adsWithVideo, 0);
const hookAdv = tally((x) => x.hooks);
const priceAdv = tally((x) => x.prices);
const buttonAdv = tally((x) => x.ctas);
const langAds = {}; for (const x of about) for (const [k, v] of Object.entries(x.languages ?? {})) langAds[k] = (langAds[k] ?? 0) + v;
const siteAdv = tally((x) => x.websites);
const wa = about.filter((x) => Object.keys(x.websites ?? {}).some((h) => /whatsapp|wa\.me|wa\.link/.test(h))).length;
const newcomers = about.filter((x) => x.startedLast30Days > 0 && (x.longestRunningDays ?? 0) <= 45);
const veterans = [...about].filter((x) => (x.longestRunningDays ?? 0) >= 180).sort((p, q) => q.longestRunningDays - p.longestRunningDays);
const withContacts = about.filter((x) => Object.keys(x.contacts ?? {}).length);
const list = (items, n) => items.slice(0, n).map(([k, v]) => `<b>${esc(k)}</b> (${v})`).join(', ');

const insights = `<ul class="insights">
  <li><b>Format.</b> ${pct(videoTotal, adTotal)} of the ${adTotal} ads read from these advertisers are video; the rest are pictures and carousels.</li>
  <li><b>Buttons.</b> ${wa} of ${about.length} advertisers send people to WhatsApp. Most used: ${list(entries(buttonAdv), 4)} (advertisers using each).</li>
  <li><b>What the copy leans on.</b> ${entries(hookAdv).length ? list(entries(hookAdv), 8) : 'nothing recognisable'} (advertisers using each).</li>
  ${entries(priceAdv).length ? `<li><b>Prices quoted.</b> ${list(entries(priceAdv), 6)}.</li>` : ''}
  <li><b>Language.</b> ${entries(langAds).map(([k, v]) => `${esc(k)} ${v} ads`).join(', ') || '-'} (a rough guess from the words used).</li>
  ${veterans.length ? `<li><b>Staying power.</b> Advertisers whose oldest ad has run 6 months or more: ${veterans.slice(0, 6).map((x) => `${a('#' + slug(x.pageName), x.pageName)} (${days(x.longestRunningDays)})`).join(', ')}.</li>` : ''}
  ${newcomers.length ? `<li><b>New this month.</b> ${newcomers.slice(0, 8).map((x) => a('#' + slug(x.pageName), x.pageName)).join(', ')} only started advertising in the last 45 days.</li>` : ''}
  ${withContacts.length ? `<li><b>Contact numbers found in the copy.</b> ${withContacts.slice(0, 8).map((x) => `${a('#' + slug(x.pageName), x.pageName)}: ${esc(Object.keys(x.contacts).join(', '))}`).join('; ')}.</li>` : ''}
  <li><b>What is not here.</b> Meta does not publish spend, reach or audience for ads outside the EU, so there are no budgets in this report. Google's side: ${g.advertisers?.length ? 'see below' : 'not read this time'}.</li>
</ul>`;

// ------------------------------------------------------------------ Google

const googleRows = (g.advertisers ?? []).map((x) => `<tr>
  <td><b>${a(x.url, x.name ?? 'unknown')}</b><div class="sub">${esc(x.registeredCountry ?? '')}${(x.websites ?? []).length ? ` · ${esc(x.websites.join(', '))}` : ''}</div></td>
  <td class="n">${x.adsInCountry}</td>
  <td>${esc(x.firstShown ?? '-')} to ${esc(x.lastShown ?? '-')}${x.activeNow ? ' <span class="pill">running</span>' : ''}</td>
  <td>${x.formats ? `${x.formats.image} picture, ${x.formats.rich} rich` : '-'}</td>
</tr><tr class="more"><td colspan="4"><div class="strip">${(x.sampleAds ?? []).filter((c) => c.format === 'image' && c.previewUrl).slice(0, 4).map((c) => `<img src="${esc(pic(c.previewUrl))}" alt="" loading="lazy">`).join('')}</div></td></tr>`).join('\n');
const googleOk = ['ok', 'partial'].includes(g.status) && (g.advertisers ?? []).length;
const statusText = { ok: 'read', partial: 'read in part', empty: 'nothing found', 'rate-limited': 'blocked by Google for now', failed: 'failed', 'no-browser': 'no browser on the PC' };
const both = (r.advertisers ?? []).filter((x) => (x.platforms ?? []).length === 2);
const started = r.startedAt ? new Date(r.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

// ------------------------------------------------------------------ the page

const overview = about.map((x) => `<tr>
  <td><b><a href="#${esc(slug(x.pageName))}">${esc(x.pageName ?? 'unknown')}</a></b></td>
  <td class="n">${x.adsSeen}</td><td class="n">${x.activeAds}</td><td class="n">${days(x.longestRunningDays)}</td>
  <td>${esc(top(x.ctas, 2))}</td><td>${esc(top(x.hooks, 3))}</td></tr>`).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ads research: ${esc(r.industry)} in ${esc(r.countryName ?? r.country)}</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1c2430; background: #f6f7f9; margin: 0; }
  main { max-width: 1000px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; } h2 { font-size: 22px; margin: 44px 0 8px; } h3 { font-size: 18px; margin: 0; }
  p { margin: 6px 0; } .lead { color: #5b6675; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: #fff; border: 1px solid #e2e6ec; border-radius: 10px; padding: 14px 16px; }
  .card b { display: block; font-size: 26px; } .card span { color: #5b6675; font-size: 14px; }
  .note { background: #fff6e0; border: 1px solid #f0d58a; border-radius: 10px; padding: 12px 16px; margin: 16px 0; }
  .insights { background: #fff; border: 1px solid #e2e6ec; border-radius: 10px; padding: 14px 16px 14px 36px; } .insights li { margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e6ec; border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 13px; color: #5b6675; background: #eef1f5; padding: 8px 12px; }
  td { padding: 9px 12px; border-top: 1px solid #e2e6ec; vertical-align: top; }
  td.n { white-space: nowrap; font-weight: 600; } .sub, .meta { color: #5b6675; font-size: 13px; font-weight: 400; }
  tr.more td { border-top: 0; padding-top: 0; background: #fbfcfd; }
  .adv { background: #fff; border: 1px solid #e2e6ec; border-radius: 12px; padding: 18px; margin: 18px 0; }
  .advhead { display: flex; gap: 12px; align-items: center; } .avatar { width: 48px; height: 48px; border-radius: 50%; background: #e2e6ec; object-fit: cover; flex: none; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
  .facts div { background: #f3f5f8; border-radius: 8px; padding: 8px 12px; font-size: 14px; } .facts b { font-size: 18px; }
  .rows > div { margin: 6px 0; } .k { display: inline-block; min-width: 140px; font-size: 13px; color: #5b6675; } .k.gap { margin-left: 14px; min-width: 0; margin-right: 6px; }
  .chip { display: inline-block; background: #e8eef9; color: #1f3d73; border-radius: 99px; padding: 1px 10px; font-size: 13px; margin: 2px 4px 2px 0; }
  .ads { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; margin-top: 14px; }
  .ad { display: grid; grid-template-columns: 150px 1fr; gap: 12px; border: 1px solid #e2e6ec; border-radius: 10px; padding: 10px; background: #fbfcfd; }
  .pic { position: relative; } .pic img { width: 150px; max-height: 220px; object-fit: cover; border-radius: 6px; display: block; background: #e2e6ec; }
  .nopic { width: 150px; height: 100px; border-radius: 6px; background: #eef1f5; color: #8a94a3; font-size: 12px; display: flex; align-items: center; justify-content: center; text-align: center; }
  .tag { position: absolute; left: 6px; top: 6px; background: #1c2430; color: #fff; font-size: 11px; border-radius: 4px; padding: 0 6px; }
  .head { font-weight: 600; margin: 2px 0; } .copy { font-size: 14px; white-space: pre-line; margin: 4px 0; }
  .pill { background: #dff3e4; color: #1d6b34; border-radius: 99px; padding: 1px 8px; font-size: 12px; }
  .strip img { height: 90px; margin-right: 8px; border-radius: 4px; }
  a { color: #1b5fb5; } details { margin-top: 6px; } summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  ul.plain { columns: 2; padding-left: 18px; }
  @media (max-width: 700px) { .ads { grid-template-columns: 1fr; } .ad { grid-template-columns: 110px 1fr; } .pic img, .nopic { width: 110px; } ul.plain { columns: 1; } table { font-size: 14px; } }
</style></head><body><main>
<h1>${esc(r.industry)} advertisers in ${esc(r.countryName ?? r.country)}</h1>
<p class="lead">From Meta's Ad Library and Google's Ads Transparency Center${started ? `, read on ${esc(started)}` : ''}.</p>

${(r.notes ?? []).length ? `<div class="note"><b>Read this first.</b> ${(r.notes ?? []).map((n) => `<p>${esc(n)}</p>`).join('')}${g.status === 'rate-limited' ? '<p>So this report covers Meta only. Run the search again later to add Google.</p>' : ''}</div>` : ''}

<div class="cards">
  <div class="card"><b>${about.length}</b><span>${esc(r.industry)} advertisers on Meta</span></div>
  <div class="card"><b>${nice(m.totalResults)}</b><span>Meta ads match "${esc(r.industry)}" in total</span></div>
  <div class="card"><b>${nice(m.adsRead)}</b><span>ads read for this report</span></div>
  <div class="card"><b>${(g.advertisers ?? []).length || '-'}</b><span>advertisers on Google (${esc(statusText[g.status] ?? g.status ?? 'not run')})</span></div>
</div>

<h2>What the ads add up to</h2>
${insights}

<h2>The advertisers at a glance</h2>
<p class="lead">Advertisers whose name or ads are about ${esc(r.industry)}, most ads first. Searched for: ${esc((m.terms ?? []).map((t) => t.term).join(', '))}. Click a name to jump to their ads.</p>
${about.length ? `<table><tr><th>Advertiser</th><th>Ads</th><th>Running</th><th>Oldest ad</th><th>Buttons</th><th>Hooks</th></tr>${overview}</table>` : '<p>No advertisers found.</p>'}

<h2>Each advertiser and their ads</h2>
<p class="lead">"Oldest ad" is how long the longest-running ad has been shown: an ad that has run for months is usually one that works. Click a picture to open the ad in Meta's library.</p>
${about.map(advertiserBlock).join('\n')}

${other.length ? `<details><summary>${other.length} other advertisers came up for the word but do not look like ${esc(r.industry)} companies</summary>
<p class="lead">Marketplaces, games and shops that only mention the word. Not checked further.</p>
<ul class="plain">${other.map((x) => `<li>${a(x.libraryUrl, x.pageName ?? 'unknown')} (${x.adsSeen})</li>`).join('')}</ul></details>` : ''}

<h2>Google</h2>
${googleOk ? `<p class="lead">Advertisers showing ads in ${esc(r.countryName ?? r.country)}, most ads first.</p>
<table><tr><th>Advertiser</th><th>Ads</th><th>Shown</th><th>Formats</th></tr>${googleRows}</table>`
  : `<p>Google's side was not read this time (${esc(statusText[g.status] ?? g.status ?? 'not run')}${g.error ? `: ${esc(g.error)}` : ''}).</p>`}

${both.length ? `<h2>On both platforms</h2><ul>${both.map((x) => `<li><b>${esc(x.name)}</b>: ${x.googleAds} Google ads, ${x.metaAds} Meta ads</li>`).join('')}</ul>` : ''}
</main></body></html>
`;

const out = dest ?? src.replace(/\.json$/i, '') + '.html';
fs.writeFileSync(out, html);
console.log(out);
