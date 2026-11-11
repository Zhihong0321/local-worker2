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
// The analysis (analyze.mjs), when there is one: inside the file, or next to it as <name>.analysis.json.
const anFile = src.replace(/\.json$/i, '') + '.analysis.json';
let an = raw.analysis ?? null;
try { if (!an && fs.existsSync(anFile)) an = JSON.parse(fs.readFileSync(anFile, 'utf8')); } catch (e) { console.error(`analysis not read: ${e.message}`); }
const C = an?.counts ?? null;
const W = an?.written ?? null;
const labelOf = (id) => an?.labels?.[id] ?? null;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const a = (href, label) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label));
const entries = (o) => Object.entries(o ?? {}).sort((x, y) => y[1] - x[1]);
const top = (o, n = 3) => entries(o).slice(0, n).map(([k]) => k).join(', ') || '-';
const days = (n) => (n == null ? '-' : n >= 60 ? `${Math.round(n / 30)} months` : `${n} days`);
const nice = (n) => (n == null ? '-' : Number(n).toLocaleString('en-GB'));
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-');
const cut = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n).trimEnd() + '…' : s; };
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const g = r.google ?? {};
const m = r.meta ?? {};
const metaAds = m.advertisers ?? [];
// With an analysis, the LLM's reading of each ad decides who is in the market, ranked by ad-days; without one, the keyword match.
const inMarket = C ? new Map([...C.shareOfVoice.map((s) => s.pageId), ...(C.marketPageIds ?? []).filter((id) => !C.shareOfVoice.some((s) => s.pageId === id))].map((id, i) => [id, i])) : null;
const foreignIds = new Set([...(C?.foreign ?? []), ...(C?.unclearLocation ?? [])].map((f) => f.pageId));
const about = inMarket ? metaAds.filter((x) => inMarket.has(x.pageId)).sort((x, y) => inMarket.get(x.pageId) - inMarket.get(y.pageId))
  : metaAds.filter((x) => x.relevance !== 'unconfirmed').sort((x, y) => y.adsSeen - x.adsSeen || (y.longestRunningDays ?? 0) - (x.longestRunningDays ?? 0));
const foreignAds = inMarket ? metaAds.filter((x) => foreignIds.has(x.pageId)) : [];
const other = inMarket ? metaAds.filter((x) => !inMarket.has(x.pageId) && !foreignIds.has(x.pageId)) : metaAds.filter((x) => x.relevance === 'unconfirmed');
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
  <div class="pic">${picture}${ad.hasVideo ? '<span class="vtag">video</span>' : ''}</div>
  <div class="txt">
    <div class="meta">${ad.active ? '<span class="pill">running</span> ' : 'ended · '}since ${esc(ad.start ?? '?')}${extra}${host}</div>
    ${labelOf(ad.id)?.summary ? `<div class="aisum">${esc(labelOf(ad.id).summary)}</div><div class="tags">${(labelOf(ad.id).angles ?? []).map((x) => `<span class="tag conf">${esc(x.replace(/-/g, ' '))}</span>`).join('')}${labelOf(ad.id).financing ? '<span class="tag good">financing</span>' : ''}</div>` : ''}
    ${ad.headline ? `<div class="hl">${esc(cut(ad.headline, 140))}</div>` : ''}
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
    <div class="tags"><span class="tag ${x.relevance === 'name-match' ? 'conf' : 'check'}">${x.relevance === 'name-match' ? 'In the name' : 'In the ads'}</span>${x.activeAds ? `<span class="tag good">${x.activeAds} running</span>` : ''}</div>
  </div>
  <div class="facts">
    <div><b>${x.adsSeen}</b> ads seen<span class="sub">${x.activeAds} running now</span></div>
    <div><b>${days(x.longestRunningDays)}</b> oldest ad<span class="sub">first started ${esc(x.firstStarted ?? '?')}</span></div>
    <div><b>${x.startedLast30Days}</b> new in 30 days<span class="sub">latest ${esc(x.lastStarted ?? '?')}</span></div>
    <div><b>${pct(x.adsWithVideo, x.adsSeen)}</b> video<span class="sub">${esc(top(x.formats, 2).toLowerCase())}</span></div>
  </div>
  <div class="arows">
    <div><span class="k">Hooks in the copy</span>${chips(x.hooks)}</div>
    ${Object.keys(x.prices ?? {}).length || Object.keys(x.percents ?? {}).length ? `<div><span class="k">Prices and numbers</span>${chips({ ...x.prices, ...x.percents })}</div>` : ''}
    ${Object.keys(x.contacts ?? {}).length ? `<div><span class="k">Phone numbers</span>${chips(x.contacts)}</div>` : ''}
    <div><span class="k">Buttons</span>${chips(x.ctas)}</div>
    <div><span class="k">Language</span>${chips(x.languages)}</div><div><span class="k">Shown on</span>${chips(Object.fromEntries(Object.entries(x.platforms ?? {}).map(([k, v]) => [k.toLowerCase().replace('_', ' '), v])), 6)}</div>
    <div><span class="k">Sends people to</span>${chips(x.websites)}</div>
  </div>
  <div class="ads">${(x.sampleAds ?? []).map(adCard).join('')}</div>
  ${x.adsSeen > (x.sampleAds ?? []).length ? `<p class="after">Showing ${(x.sampleAds ?? []).length} of ${x.adsSeen} ads seen: the three longest-running, then the newest. ${a(x.libraryUrl, 'All of this advertiser\'s ads in the library')}</p>` : ''}
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
// The look is the Company Dive preview's (Fable 5.2 redesign): dark top bar and hero,
// full-width bands, square marks, Inter Tight headings, one mark per advertiser.

const place = esc(r.countryName ?? r.country);
const industry = esc(r.industry);
const shortDate = r.startedAt ? new Date(r.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const dots = (n, cls = '', max = 18) => Array.from({ length: Math.min(n, max) }, () => `<i class="dot ${cls}"></i>`).join('') + (n > max ? `<span class="more">+${n - max}</span>` : '');
const mention = about.filter((x) => x.relevance === 'ads-mention').length;
const named = about.length - mention;
const gCount = (g.advertisers ?? []).length;
const gNote = g.status === 'ok' ? 'Read in full' : g.status === 'partial' ? 'Read in part' : statusText[g.status] ?? 'Not run';
const firstNote = (r.notes ?? [])[0];

const overview = about.map((x) => `<li><span><span class="tag ${x.relevance === 'name-match' ? 'conf' : 'check'}">${x.relevance === 'name-match' ? 'In the name' : 'In the ads'}</span></span>
  <span class="t"><a href="#${esc(slug(x.pageName))}">${esc(x.pageName ?? 'unknown')}</a> <span class="g">· ${x.adsSeen} ads, ${x.activeAds} running · oldest ${days(x.longestRunningDays)} · ${esc(top(x.ctas, 2))}</span></span></li>`).join('\n');

const insightCards = [
  ['Format', `${pct(videoTotal, adTotal)} video`, `Of the ${adTotal} ads read from these advertisers. The rest are pictures and carousels.`, ''],
  ['Buttons', `${wa} of ${about.length} use WhatsApp`, `Most used: ${list(entries(buttonAdv), 4) || '-'} (advertisers using each).`, ''],
  ['Hooks', entries(hookAdv).length ? `${entries(hookAdv).length} kinds seen` : 'None recognised', entries(hookAdv).length ? `${list(entries(hookAdv), 8)} (advertisers using each).` : 'The copy names no offer, saving or guarantee the list knows.', entries(hookAdv).length ? '' : 'check'],
  ['Prices quoted', entries(priceAdv).length ? `${entries(priceAdv).length} price points` : 'None in the copy', entries(priceAdv).length ? `${list(entries(priceAdv), 6)}.` : 'No advertiser puts a price in the ad text.', entries(priceAdv).length ? '' : 'none'],
  ['Language', top(langAds, 1), `${entries(langAds).map(([k, v]) => `${esc(k)} ${v} ads`).join(', ') || '-'}. A rough guess from the words used.`, ''],
  ['Staying power', `${veterans.length} over 6 months`, veterans.length ? `${veterans.slice(0, 6).map((x) => `${a('#' + slug(x.pageName), x.pageName)} (${days(x.longestRunningDays)})`).join(', ')}. An ad that runs for months is usually one that works.` : 'No advertiser has kept an ad running for 6 months.', 'good'],
  ['New this month', `${newcomers.length} newcomers`, newcomers.length ? `${newcomers.slice(0, 8).map((x) => a('#' + slug(x.pageName), x.pageName)).join(', ')} started advertising in the last 45 days.` : 'Nobody started advertising in the last 45 days.', newcomers.length ? 'first' : 'none'],
  ['Phone numbers in the copy', `${withContacts.length} advertisers`, withContacts.length ? withContacts.slice(0, 8).map((x) => `${a('#' + slug(x.pageName), x.pageName)}: ${esc(Object.keys(x.contacts).join(', '))}`).join('; ') + '.' : 'No phone number is printed in the ad text.', withContacts.length ? '' : 'none'],
].map(([k, big, d, cls]) => `<article class="q ${cls}"><p class="eyebrow">${esc(k)}</p><h3>${big}</h3><p class="d">${d}</p></article>`).join('\n');

// ------------------------------------------------------------------ the analysis (analyze.mjs)

const label = (k) => esc(String(k ?? '').replace(/-/g, ' '));
const bar = (share, cls = '') => `<span class="bar ${cls}"><i style="width:${Math.max(2, Math.min(100, Number(share) || 0))}%"></i></span>`;
const flagged = (o) => (o.unmatchedNumbers ?? []).length ? ` <span class="tag check" title="${esc(o.unmatchedNumbers.join(', '))}">number not in the counts</span>` : '';
const splitList = (title, rows, unit = 'ads') => `<div class="split"><h3>${esc(title)}</h3><ul>${(rows ?? []).slice(0, 7).map((x) =>
  `<li><span>${label(x.key)}</span>${bar(x.share)}<span class="n">${x.share}%</span></li>`).join('')}</ul><p class="g small">share of ${unit}</p></div>`;

let analysisHtml = '';
if (C) {
  const sov = C.shareOfVoice.slice(0, 15).map((x) => `<tr>
    <td><b><a href="#${esc(slug(x.name))}">${esc(x.name)}</a></b><div class="sub">${label(x.type)} · ${label(x.audience)}${x.language ? ` · ${esc(x.language)}` : ''}</div></td>
    <td class="n">${x.ads}<div class="sub">${x.active} running</div></td>
    <td class="w">${bar(x.shareOfAdDays, 'ink')}<span class="n">${x.shareOfAdDays}%</span></td>
    <td class="n">${days(x.longestDays)}</td>
    <td>${esc(x.channel ?? '-')}</td></tr>`).join('');
  const angles = C.angles.map((x) => `<tr><td><b>${label(x.angle)}</b></td><td class="w">${bar(x.share, 'ink')}<span class="n">${x.share}%</span></td>
    <td class="n">${x.advertisers}<div class="sub">${x.topShare}% from ${esc(cut(x.topAdvertiser, 22))}</div></td>
    <td class="n">${x.keptPast90 ? (x.keptPast90.matureAds ? `${x.keptPast90.rate}%<div class="sub">${x.keptPast90.kept} of ${x.keptPast90.matureAds} old enough</div>` : '-') : '<span class="sub">not measurable</span>'}</td>
    <td>${x.evidence === 'weak' ? `<span class="tag check" title="${esc(x.weakBecause)}">weak evidence</span><div class="sub">${esc(x.weakBecause)}</div>` : '<span class="tag good">sound</span>'}</td></tr>`).join('');
  const maxLaunch = Math.max(1, ...C.launchesByMonth.map((x) => x.launches));
  const months = C.launchesByMonth.slice(-18).map((x) => `<div class="col"><i style="height:${Math.round((100 * x.launches) / maxLaunch)}%"></i><b>${x.launches}</b><span>${esc(x.month.slice(2))}</span></div>`).join('');
  const prices = C.prices.slice(0, 14).map((x) => `<tr><td class="n">RM ${nice(x.rm)}</td><td>${esc(x.what ?? '')}${x.kwp ? ` · ${x.kwp} kWp` : ''}</td><td>${a(x.ad, x.advertiser)}</td></tr>`).join('');
  const offers = [...new Map(C.offers.map((o) => [o.offer.toLowerCase(), o])).values()].slice(0, 14).map((o) => `<li><b>${esc(o.offer)}</b> <span class="g">· ${esc(o.advertiser)}</span></li>`).join('');

  analysisHtml = `
${W ? `<section class="sec" id="verdict"><div class="in">
  <div class="head"><p class="eyebrow">The verdict</p><h2>${esc(W.headline)}</h2>${W.summary ? `<p class="lead">${esc(W.summary)}</p>` : ''}</div>
  <div class="finds">${W.findings.map((f, i) => `<article class="find"><span class="no">${String(i + 1).padStart(2, '0')}</span><div><h3>${esc(f.title)}${flagged(f)}</h3><p>${esc(f.detail)}</p>${f.evidence ? `<p class="ev">From: ${esc(f.evidence)}</p>` : ''}</div></article>`).join('')}</div>
  <p class="after">Written by an AI model (${esc(an.models?.write ?? '')}) from the counts on this page only. The counts themselves are made by code from ${C.adsLabelled} labelled ads.</p>
</div></section>` : ''}

<section class="sec band" id="share"><div class="in">
  <div class="head"><p class="eyebrow">Share of voice</p><h2>Who is pushing hardest. <span class="g">By ad-days: ads × days each has run.</span></h2>
  <p class="lead">${C.advertisersInMarket} local advertisers sell ${industry} in these ads. Ranked here: the ${C.advertisersRanked} with two ads or more; ${C.oneAdAdvertisers.length} with a single ad are listed further down. ${C.advertisersForeign} foreign brands whose ads reach ${place} and ${C.advertisersOffTopic} advertisers that only mention the word are left out. Ad-days counts each ad at most a year. It is not spend, which Meta does not publish here, but it ranks who keeps paying for ads.</p></div>
  <table class="gtab"><tr><th>Advertiser</th><th>Ads</th><th>Share of ad-days</th><th>Oldest ad</th><th>Sends people to</th></tr>${sov}</table>
</div></section>

<section class="sec" id="angles"><div class="in">
  <div class="head"><p class="eyebrow">What they say</p><h2>The reasons they give to buy. <span class="g">And how much each one can be trusted.</span></h2>
  <p class="lead">Each ad is tagged with up to three angles. ${C.measurable?.runTime ? "Kept past 90 days: of the ads at least 90 days old, the share that ran 90 days or more. Ads that keep running are usually the ones that pay." : esc(C.measurable?.why ?? "")} An angle is weak evidence when fewer than four advertisers use it or one advertiser carries half of it; the verdict is not built on those.</p></div>
  <table class="gtab"><tr><th>Angle</th><th>Share of ads</th><th>Advertisers</th><th>Kept past 90 days</th><th>Evidence</th></tr>${angles}</table>
</div></section>

<section class="sec band" id="aim"><div class="in">
  <div class="head"><p class="eyebrow">Who and how</p><h2>Who they aim at, <span class="g">and how they ask for the sale.</span></h2>
  <p class="lead">${C.financing.share}% of ads offer financing.${C.schemes.length ? ` Government schemes named: ${C.schemes.slice(0, 5).map((s) => `${esc(s.key)} (${s.ads})`).join(', ')}.` : ' No government scheme is named.'}</p></div>
  <div class="splits">${splitList('Audience', C.audience)}${splitList('Sends people to', C.channels)}${splitList('Language', C.languages)}${splitList('Format', C.formats)}
  <div class="split"><h3>Kind of business</h3><ul>${C.types.map((x) => `<li><span>${label(x.key)}</span>${bar(Math.round((100 * x.advertisers) / Math.max(1, C.advertisersInMarket)))}<span class="n">${x.advertisers}</span></li>`).join('')}</ul><p class="g small">advertisers</p></div></div>
</div></section>

${C.measurable?.launches && C.launchesByMonth.length ? `<section class="sec" id="timeline"><div class="in">
  <div class="head"><p class="eyebrow">When</p><h2>New ads by month. <span class="g">Among the ads read.</span></h2>
  ${C.newcomers.length ? `<p class="lead">Started advertising in the last 45 days: ${C.newcomers.slice(0, 8).map((n) => `<b>${esc(n)}</b>`).join(', ')}.</p>` : ''}</div>
  <div class="cols">${months}</div>
</div></section>` : ''}

${prices || offers ? `<section class="sec band" id="offers"><div class="in">
  <div class="head"><p class="eyebrow">Offers and prices</p><h2>What they put on the table. <span class="g">As written in the ads.</span></h2></div>
  <div class="cmp">${prices ? `<div><h3>Prices stated</h3><table class="gtab">${prices}</table></div>` : '<div><h3>Prices stated</h3><p class="g">No ad states a price.</p></div>'}
  <div class="no"><h3>Offers</h3><ul class="offers">${offers || '<li>No concrete offer found.</li>'}</ul></div></div>
</div></section>` : ''}

${W?.players?.length ? `<section class="sec" id="players"><div class="in">
  <div class="head"><p class="eyebrow">The players</p><h2>How the most active ones position themselves.</h2></div>
  <div class="qs">${W.players.map((p) => `<article class="q"><h3><a href="#${esc(slug(p.name))}">${esc(p.name)}</a>${flagged(p)}</h3><p class="d">${esc(p.positioning)}</p><p class="lk"><span><b>Watch:</b> ${esc(p.watch)}</span></p></article>`).join('')}</div>
</div></section>` : ''}

${W && (W.gaps.length || W.moves.length) ? `<section class="sec dark" id="moves"><div class="in offer">
  <div><p class="eyebrow">The openings</p><h2>Where nobody is talking yet.</h2>
    <ul class="gets">${W.gaps.map((x) => `<li><b>${esc(x.title)}${flagged(x)}</b><span>${esc(x.detail)}</span></li>`).join('')}</ul></div>
  <div class="ask"><p class="eyebrow">What to do next</p>${W.moves.map((x, i) => `<div class="move"><span class="no">${i + 1}</span><div><b>${esc(x.title)}${flagged(x)}</b><p>${esc(x.detail)}</p></div></div>`).join('')}</div>
</div></section>` : ''}
`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Ads research: ${industry} in ${place}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600&family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{
  color-scheme:light;
  --ink:#111418;--grey:#535a64;--muted:#7d848e;--line:#e3e6ea;--band:#f2f3f5;--paper:#ffffff;
  --dark:#0e1013;--dark-2:#1a1f26;--dark-line:#2a3038;--on-dark:#f3f4f6;--on-dark-2:#a2a9b3;
  --first:#b42318;--first-bg:#fdecea;--check:#96560a;--check-bg:#fdf3e2;--good:#067647;--good-bg:#e5f4ec;
  --display:"Inter Tight","Inter","Noto Sans SC","Noto Sans KR",system-ui,sans-serif;
  --body:"Inter","Noto Sans SC","Noto Sans KR",system-ui,sans-serif;
  --w:1080px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.55}
h1,h2,h3{font-family:var(--display);font-weight:600;margin:0;letter-spacing:-0.025em;line-height:1.08;text-wrap:balance}
p{margin:0;text-wrap:pretty}a{color:inherit}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.in{max-width:calc(var(--w) + 40px);margin:0 auto;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}
.sec{padding-block:88px;scroll-margin-top:56px}
.band{background:var(--band)}
.dark{background:var(--dark);color:var(--on-dark);-webkit-font-smoothing:antialiased}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.dark .eyebrow{color:var(--on-dark-2)}
.g{color:var(--muted)}.dark .g{color:var(--on-dark-2)}
h2{font-size:clamp(30px,4vw,50px);max-width:17em}
.head{display:grid;gap:14px;margin-bottom:40px}
.lead{font-size:18px;color:var(--grey);max-width:36em}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--paper);color:var(--ink);font:600 15px/1 var(--body);padding:15px 22px;text-decoration:none;border:0;cursor:pointer}
.btn:hover{opacity:.9}
.btn.inv{background:var(--ink);color:var(--paper)}

.top{position:sticky;top:0;z-index:9;background:var(--dark);color:var(--on-dark);font-size:13px;border-bottom:1px solid var(--dark-line)}
.top .in{display:flex;justify-content:space-between;align-items:center;gap:14px;padding-block:9px}
.top b{font-weight:600}.top .for{color:var(--on-dark-2)}
.top .r{display:flex;align-items:center;gap:14px;flex:none}
.top .pr{font-family:var(--display);font-size:17px;font-weight:600}
.top .btn{padding:10px 14px;font-size:13px}

.hero .in{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:56px;align-items:center;padding-block:76px 84px}
.hero h1{font-size:clamp(34px,4.5vw,60px);letter-spacing:-0.032em;margin-top:18px}
.hero .sub{margin-top:22px;font-size:18px;line-height:1.5;color:var(--on-dark);opacity:.88;max-width:32em}
.deadline{margin-top:26px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px;align-items:center;border:1px solid var(--dark-line);background:var(--dark-2);padding:14px 18px;max-width:34em;text-decoration:none}
.deadline .date{font-family:var(--display);font-size:26px;font-weight:600;letter-spacing:-0.02em;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap}
.deadline .date small{display:block;font:600 10.5px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;color:#ff9c8f;margin-bottom:6px}
.deadline span{font-size:14.5px;color:var(--on-dark-2)}.deadline span b{color:var(--on-dark);font-weight:600}
.ctas{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:30px}
.ctas .alt{font-size:14.5px;color:var(--on-dark-2)}
.anyone{margin-top:18px;font-size:13px;color:var(--on-dark-2)}

.card{background:var(--paper);color:var(--ink);padding:24px 24px 20px;border-top:3px solid var(--paper);box-shadow:0 0 0 1px var(--dark-line);min-width:0}
.cardhead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-bottom:14px;border-bottom:2px solid var(--ink)}
.cardhead h3{font-size:20px}.cardhead span{font-size:12px;color:var(--muted);white-space:nowrap}
.areas-sc{list-style:none;margin:0;padding:0}
.areas-sc li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 14px;align-items:center;padding:13px 0;border-bottom:1px solid var(--line)}
.areas-sc a{text-decoration:none;font-weight:600;font-size:15px}
.areas-sc a:hover{text-decoration:underline}
.areas-sc .n{font-size:13px;color:var(--grey);font-variant-numeric:tabular-nums;white-space:nowrap}
.dots{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dots .more{font-size:12px;color:var(--grey);font-variant-numeric:tabular-nums}
.dot{width:13px;height:13px;border-radius:50%;background:var(--ink);flex:none}
.dot.c{background:none;border:2px solid var(--check)}
.dot.f{background:var(--first)}
.dot.o{background:var(--paper);border:2px solid var(--ink)}
.key{display:flex;flex-wrap:wrap;gap:6px 16px;padding-top:14px;font-size:12px;color:var(--grey)}
.key span{display:inline-flex;align-items:center;gap:6px}.key .dot{width:10px;height:10px}
.total{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-top:14px}
.total b{font-family:var(--display);font-size:34px;font-weight:600;letter-spacing:-0.03em;line-height:1;font-variant-numeric:tabular-nums}
.total span{font-size:13px;color:var(--grey);text-align:right}

.tags{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tag{display:inline-flex;align-items:center;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;white-space:nowrap;border:1px solid transparent}
.tag.first{background:var(--first);color:#fff}
.tag.conf{background:var(--band);color:var(--grey);border-color:var(--line)}
.tag.check{background:var(--check-bg);color:var(--check);border-color:#f0d6a4}
.tag.good{background:var(--good-bg);color:var(--good)}
.tag.open{background:var(--paper);color:var(--ink)}
.tag.none{background:var(--band);color:var(--grey);border-color:var(--line)}
.after{margin-top:18px;font-size:15px;color:var(--grey);max-width:44em}

.qs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.q{background:var(--paper);padding:24px;display:grid;gap:10px;align-content:start;border-top:3px solid var(--ink);min-width:0}
.q.first{border-top-color:var(--first)}.q.check{border-top-color:var(--check)}.q.none{border-top-color:var(--muted)}.q.good{border-top-color:var(--good)}
.q h3{font-size:22px;line-height:1.18}.q .d{color:var(--grey);font-size:14.5px;overflow-wrap:anywhere}.q .d b{color:var(--ink);font-weight:600}

.groups{display:grid;gap:30px}
.group h3{font-size:20px;display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-bottom:10px;border-bottom:2px solid var(--ink)}
.group h3 small{font:500 13px/1 var(--body);letter-spacing:0;color:var(--muted);white-space:nowrap}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:grid;grid-template-columns:120px minmax(0,1fr);gap:16px;align-items:baseline;padding:15px 0;border-bottom:1px solid var(--line)}
.rows .t{font-size:16px}.rows .t a{font-weight:600}

.adv{scroll-margin-top:56px;padding-block:34px;border-bottom:1px solid var(--line)}
.adv:first-of-type{padding-top:0}
.advhead{display:flex;gap:14px;align-items:center;padding-bottom:14px;border-bottom:2px solid var(--ink)}
.advhead h3{font-size:clamp(22px,2.4vw,28px)}.advhead h3 a{text-decoration:none}.advhead h3 a:hover{text-decoration:underline}
.advhead .tags{margin-left:auto}
.avatar{width:44px;height:44px;border-radius:50%;background:var(--band);object-fit:cover;flex:none}
.sub,.meta{color:var(--grey);font-size:13px;font-weight:400}
.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin:0 0 6px;border-bottom:1px solid var(--line)}
.facts div{padding:16px 16px 16px 0;font-size:13px;color:var(--grey);display:grid;gap:2px}
.facts div+div{padding-left:16px;border-left:1px solid var(--line)}
.facts b{font-family:var(--display);font-size:26px;font-weight:600;letter-spacing:-0.03em;line-height:1.1;color:var(--ink);font-variant-numeric:tabular-nums}
.arows>div{display:grid;grid-template-columns:170px minmax(0,1fr);gap:12px;padding:9px 0;border-bottom:1px solid var(--line);align-items:baseline}
.arows .k{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.arows .k.gap{display:none}
.chip{display:inline-flex;font-size:13px;padding:2px 9px;margin:2px 6px 2px 0;background:var(--band);border:1px solid var(--line);color:var(--ink)}
.ads{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:14px;margin-top:20px}
.ad{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;background:var(--paper);border-top:3px solid var(--ink);box-shadow:0 0 0 1px var(--line);padding:16px}
.pic{position:relative}.pic img{width:150px;max-height:230px;object-fit:cover;display:block;background:var(--band)}
.nopic{width:150px;height:100px;background:var(--band);color:var(--muted);font-size:12px;display:flex;align-items:center;justify-content:center;text-align:center}
.vtag{position:absolute;left:0;top:0;background:var(--dark);color:var(--on-dark);font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px}
.hl{font-family:var(--display);font-weight:600;font-size:17px;letter-spacing:-0.01em;line-height:1.25;margin:6px 0 4px}
.copy{font-size:14px;white-space:pre-line;margin:4px 0;color:var(--ink)}
.txt .meta{margin-top:6px}.txt{min-width:0;overflow-wrap:anywhere}
.pill{display:inline-flex;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;background:var(--good-bg);color:var(--good)}
details{margin-top:6px}summary{cursor:pointer;font-weight:600;font-size:13px}
.strip{display:flex;flex-wrap:wrap;gap:8px}.strip img{height:90px}
.gtab{width:100%;border-collapse:collapse;font-size:15px;font-variant-numeric:tabular-nums}
.gtab th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);padding:10px 12px 10px 0;border-bottom:2px solid var(--ink)}
.gtab td{padding:13px 12px 13px 0;border-bottom:1px solid var(--line);vertical-align:top}
.gtab td.n{font-weight:600;white-space:nowrap}
.gtab tr.more td{border-bottom:1px solid var(--line);padding-top:0}
.gtab tr.more+tr td{border-top:0}
ul.plain{columns:2;padding-left:18px;font-size:15px}

.cmp{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.cmp>div{background:var(--band);padding:26px;display:grid;gap:14px;align-content:start}
.cmp>div.no{background:var(--dark);color:var(--on-dark);-webkit-font-smoothing:antialiased}
.cmp h3{font-size:21px}
.cmp ul{list-style:none;margin:0;padding:0;display:grid;gap:11px;font-size:15.5px}
.cmp li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;align-items:start}
.cmp li svg{margin-top:4px}

.bar{display:inline-block;width:min(220px,55%);height:8px;background:var(--line);vertical-align:middle;margin-right:10px}.bar i{display:block;height:100%;background:var(--grey)}.bar.ink i{background:var(--ink)}
.gtab td.w{white-space:nowrap}.gtab .n,.split .n{font-weight:600;font-variant-numeric:tabular-nums}
.finds{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 40px}
.find{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;padding:22px 0;border-top:2px solid var(--ink)}
.find .no{font-family:var(--display);font-size:22px;font-weight:600;color:var(--muted)}
.find h3{font-size:21px;line-height:1.2;margin-bottom:8px}.find p{color:var(--grey);font-size:15.5px}.find .ev{font-size:12.5px;color:var(--muted);margin-top:8px}
.splits{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.split{background:var(--paper);padding:20px 22px;border-top:3px solid var(--ink)}.split h3{font-size:18px;margin-bottom:10px}
.split ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}.split li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;font-size:14px}
.split li .bar{width:90px;margin:0}.split .small{font-size:12px;margin-top:10px}
.cols{display:flex;gap:6px;align-items:flex-end;height:220px;border-bottom:2px solid var(--ink);padding-top:24px}
.col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;position:relative;min-width:0}
.col i{display:block;width:100%;background:var(--ink)}.col b{font-size:12px;order:-1;margin-bottom:4px}.col span{position:absolute;bottom:-22px;font-size:11px;color:var(--muted);white-space:nowrap}
#timeline .cols{margin-bottom:30px}
ul.offers{gap:9px}ul.offers li{display:block}
.lk{display:flex;gap:9px;font-size:14px;color:var(--grey);border-top:1px solid var(--line);padding-top:12px;margin-top:4px}.lk b{color:var(--ink);font-weight:600}
.offer{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:48px;align-items:start}
.offer h2{font-size:clamp(30px,3.6vw,46px)}
.gets{list-style:none;margin:26px 0 0;padding:0;border-top:1px solid var(--dark-line)}
.gets li{padding:16px 0;border-bottom:1px solid var(--dark-line);display:grid;gap:3px}
.gets b{font-family:var(--display);font-size:19px;font-weight:600;letter-spacing:-0.015em}.gets span{font-size:14.5px;color:var(--on-dark-2)}
.ask{background:var(--paper);color:var(--ink);padding:30px;display:grid;gap:18px}
.move{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;border-top:1px solid var(--line);padding-top:16px}
.move .no{font-family:var(--display);font-size:28px;font-weight:600;line-height:1}.move b{font-family:var(--display);font-size:18px;font-weight:600}.move p{color:var(--grey);font-size:14.5px;margin-top:4px}
.aisum{font-size:13px;color:var(--grey);font-style:italic;margin:6px 0}
.probs{margin-top:14px;border-left:3px solid var(--check);padding:4px 0 4px 20px}.probs h3{font-size:17px}.probs ul{font-size:14px;color:var(--grey);padding-left:18px}
footer .in{padding-block:36px 56px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;font-size:13.5px}
footer div{display:grid;gap:4px;align-content:start}
footer .k{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}

@media (max-width:900px){
  .sec{padding-block:60px}
  .hero .in{grid-template-columns:1fr;gap:36px;padding-block:48px 56px}
  .qs{grid-template-columns:1fr 1fr}.cmp{grid-template-columns:1fr}.finds,.offer{grid-template-columns:1fr}.splits{grid-template-columns:1fr 1fr}
  .facts{grid-template-columns:1fr 1fr}.facts div:nth-child(3){padding-left:0;border-left:0}
  .top .for{display:none}
  footer .in{grid-template-columns:1fr 1fr}
}
@media (max-width:560px){
  .qs,.splits{grid-template-columns:1fr}.gtab{font-size:13.5px}.bar{width:60px}
  .rows li,.arows>div{grid-template-columns:1fr;gap:7px}
  .ads{grid-template-columns:1fr}.ad{grid-template-columns:104px minmax(0,1fr)}.pic img,.nopic{width:104px}
  .deadline{grid-template-columns:1fr;gap:10px}
  .top .pr{display:none}
  ul.plain{columns:1}
}
</style></head><body>

<header class="top"><div class="in"><div><b>Ads Research</b> <span class="for">· ${industry} in ${place}</span></div><div class="r"><span class="pr">${shortDate}</span><a class="btn" href="#advertisers">See the advertisers</a></div></div></header>

<section class="dark hero"><div class="in">
  <div>
    <p class="eyebrow">Ads research · ${place} · ${esc(shortDate)}</p>
    <h1>${W?.headline ? esc(W.headline) : ''}${W?.headline ? '' : `${about.length} advertisers are running ${industry} ads in ${place}${gCount ? `, and ${gCount} more on Google` : ''}.`}</h1>
    <p class="sub">${named} carry the industry in their name, ${mention} only in their ads. Read from ${nice(m.adsRead)} of the ${nice(m.totalResults)} Meta ads that match, with their pictures, copy and buttons below.</p>
    ${firstNote ? `<a class="deadline" href="#google"><div class="date"><small>Google</small>${esc(gNote)}</div><span><b>${esc(firstNote.replace(/^Google Ads Transparency Center: \w[\w-]* ?/, '').replace(/^\(|\)$/g, '') || firstNote)}</b> ${g.status === 'rate-limited' ? 'This report covers Meta only. Run the search again later to add Google.' : 'What was read is shown; run it again later for the rest.'}</span></a>` : ''}
    <div class="ctas"><a class="btn" href="${W ? '#verdict' : '#advertisers'}">${W ? 'Read the verdict' : 'See the advertisers'}&nbsp;↓</a><a class="alt" href="#advertisers">or see every advertiser's ads</a></div>
    <p class="anyone">Built from Meta's Ad Library and Google's Ads Transparency Center. Anyone can look these up, your rivals included.</p>
  </div>

  <aside class="card" aria-label="Advertisers by source">
    <div class="cardhead"><h3>Where they advertise</h3><span>one mark = one advertiser</span></div>
    <ul class="areas-sc">
      <li><a href="#advertisers">Meta, ${industry} in the name</a><span class="n">${named}</span><div class="dots">${dots(named)}</div></li>
      <li><a href="#advertisers">Meta, ${industry} in the ads</a><span class="n">${mention}</span><div class="dots">${dots(mention, 'c')}</div></li>
      <li><a href="#google">Google Ads</a><span class="n">${gCount}</span><div class="dots">${gCount ? dots(gCount, 'f') : '<span class="more">not read this time</span>'}</div></li>
      <li><a href="#others">Only mention the word</a><span class="n">${other.length}</span><div class="dots">${dots(other.length, 'o')}</div></li>
    </ul>
    <div class="key"><span><i class="dot"></i>In the name</span><span><i class="dot c"></i>In the ads</span><span><i class="dot f"></i>Google</span><span><i class="dot o"></i>Not checked</span></div>
    <div class="total"><b>${nice(m.adsRead)}</b><span>ads read on Meta<br>${both.length ? `${both.length} advertisers on both platforms` : 'none found on both platforms'}</span></div>
  </aside>
</div></section>

${analysisHtml}
${C ? "" : `<section class="sec band" id="adds-up"><div class="in">
  <div class="head"><p class="eyebrow">Across all of them</p><h2>What the ads add up to. <span class="g">Counted from the ads themselves.</span></h2></div>
  <div class="qs">${insightCards}</div>
</div></section>`}

<section class="sec" id="glance"><div class="in">
  <div class="head"><p class="eyebrow">At a glance</p><h2>${about.length} advertisers, <span class="g">most ads first.</span></h2><p class="lead">Searched for ${esc((m.terms ?? []).map((t) => t.term).join(', '))}. Click a name to jump to their ads.</p></div>
  <div class="groups"><div class="group"><h3>On Meta <small>${named} in the name · ${mention} in the ads</small></h3><ol class="rows">${overview}</ol></div></div>
</div></section>

<section class="sec band" id="advertisers"><div class="in">
  <div class="head"><p class="eyebrow">Each advertiser</p><h2>Their ads, as people see them. <span class="g">Oldest first, then the newest.</span></h2><p class="lead">"Oldest ad" is how long the longest-running ad has been shown. Click a picture to open the ad in Meta's library.</p></div>
  ${about.map(advertiserBlock).join('\n')}
  ${foreignAds.length ? `<details id="foreign"><summary>${foreignAds.length} foreign brands, or advertisers whose location is unclear, whose ads reach ${place}</summary>
  <p class="after">Brands based abroad, and advertisers the ads do not show to be local. They are not counted as local competitors.</p>
  <ul class="plain">${foreignAds.map((x) => `<li>${a(x.libraryUrl, x.pageName ?? 'unknown')} (${x.adsSeen})</li>`).join('')}</ul></details>` : ''}
  ${other.length ? `<details id="others"><summary>${other.length} other advertisers came up for the word but do not look like ${industry} companies</summary>
  <p class="after">Marketplaces, games and shops that only mention the word. Not checked further.</p>
  <ul class="plain">${other.map((x) => `<li>${a(x.libraryUrl, x.pageName ?? 'unknown')} (${x.adsSeen})</li>`).join('')}</ul></details>` : ''}
</div></section>

<section class="sec" id="google"><div class="in">
  <div class="head"><p class="eyebrow">Google Ads Transparency Center</p><h2>${gCount ? `${gCount} advertisers on Google. ` : 'Google. '}<span class="g">${googleOk ? `Showing ads in ${place}, most ads first.` : 'Not read this time.'}</span></h2>
  ${g.status !== 'ok' ? `<div class="tags"><span class="tag ${g.status === 'partial' ? 'check' : 'none'}">${esc(gNote)}</span></div><p class="lead">${esc(g.error ?? '')}</p>` : ''}</div>
  ${googleOk ? `<table class="gtab"><tr><th>Advertiser</th><th>Ads</th><th>Shown</th><th>Formats</th></tr>${googleRows}</table>` : ''}
  ${both.length ? `<p class="after">On both platforms: ${both.map((x) => `<b>${esc(x.name)}</b> (${x.googleAds} Google, ${x.metaAds} Meta)`).join(', ')}.</p>` : ''}
</div></section>

<section class="sec band" id="not"><div class="in">
  <div class="head"><p class="eyebrow">Read this before deciding</p><h2>What this report holds, <span class="g">and what it leaves out.</span></h2></div>
  <div class="cmp">
    <div><h3>In this report</h3><ul>
      <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>Every advertiser found, with ads seen, how long they run, buttons and formats.</span></li>
      <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>Up to six ads each, with the picture, the full copy and a link to the library.</span></li>
      <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>Prices, hooks and phone numbers printed in the ad text.</span></li>
    </ul></div>
    <div class="no"><h3>Not in this report</h3><ul>
      ${(W?.caveats ?? []).map((x) => `<li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>${esc(x)}</span></li>`).join('')}
      <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>Spend, reach and audience. Meta publishes these only for ads in the EU.</span></li>
      <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>Every ad. ${nice(m.adsRead)} of ${nice(m.totalResults)} matching Meta ads were read.</span></li>
      <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>${googleOk && g.status === 'ok' ? 'Google search ads text: Google shows those only as previews.' : `Google in full: ${esc(gNote.toLowerCase())}.`}</span></li>
    </ul></div>
  </div>
  ${(an?.problems ?? []).length ? `<div class="probs"><h3>Problems found while analysing</h3><ul>${an.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
</div></section>

<footer><div class="in">
  <div><span class="k">Market</span><span>${industry} · ${place}</span></div>
  <div><span class="k">Read</span><span>${esc(shortDate)}${r.worker ? ` · by ${esc(r.worker)}` : ''}</span></div>
  <div><span class="k">Sources</span><span>Meta Ad Library · Google Ads Transparency Center</span></div>
  <div><span class="k">Method</span><span>Every ad links back to its library entry.</span></div>
</div></footer>
</body></html>
`;

const out = dest ?? src.replace(/\.json$/i, '') + '.html';
fs.writeFileSync(out, html);
console.log(out);
