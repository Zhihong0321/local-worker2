// One ads.research job: who advertises in one country and industry, read from
// Google's Ads Transparency Center and Meta's Ad Library on this PC's own line.
// The worker runs this with its portable Node, once per job, with the job's
// payload in a JSON file, and reads one JSON line from stdout.
//
// Google needs no browser: the Transparency Center's own page calls
// adstransparency.google.com/anji/_/rpc/SearchService/*, and so does this.
// SearchSuggestions turns a word into advertisers and websites; SearchCreatives
// lists the ads one of them shows in a region (Google's region id, 2000 plus the
// ISO 3166 number: Malaysia is 2458). Meta has no such call without a login, so
// the Ad Library page is opened in the browser already on the PC (Edge on Windows,
// Chrome on a Mac), headless on a throwaway profile, and driven over the DevTools
// protocol with Node's own WebSocket, the way shot.mjs does. The first page of ads
// is in the page itself; scrolling makes the page ask for the next ones, and those
// answers are read off the wire.
//
// Nothing here stops the answer. A source that fails, is blocked or has no
// browser comes back labelled in `google.status` / `meta.status` with the reason,
// and the other source's advertisers are still returned. Meta's keyword search
// also returns ads that only mention the word (a marketplace listing a solar
// lamp): those advertisers stay in the list, labelled `relevance: 'unconfirmed'`
// and sorted below the ones whose name or ad text is about the industry.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const GOOGLE = 'https://adstransparency.google.com';
const GOOGLE_PACE_MS = 700;
/** Google answers HTTP 429 to a PC that asks too fast; the wait before the first retry, doubled each time. */
const GOOGLE_COOL_MS = 20_000;
const START_TIMEOUT_MS = 20_000;
const DAY = 86_400;

/** A word long enough to tell a company from noise: two characters of Chinese, three of anything else. */
const wordLong = (w) => (/[一-鿿]/.test(w) ? w.length >= 2 : w.length >= 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const iso = (sec) => { const n = Number(sec); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null; };
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const errText = (e) => `${e?.name ?? 'Error'}: ${e?.message ?? e}`;

/** Lower case, no company suffix and no punctuation: two spellings of one advertiser meet here. */
function nameKey(name) {
  return text(name).toLowerCase().replace(/\b(sdn\.?|bhd\.?|berhad|pte\.?|ltd\.?|limited|pty\.?|llc|inc\.?|co\.?|corp\.?|pvt\.?|pt|company|enterprise)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// ------------------------------------------------------------------- Google

async function gRpc(service, body) {
  const res = await fetch(`${GOOGLE}/anji/_/rpc/${service}?authuser=`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: GOOGLE, referer: `${GOOGLE}/`, 'user-agent': UA },
    body: 'f.req=' + encodeURIComponent(JSON.stringify(body)),
    signal: AbortSignal.timeout(25_000),
  });
  const raw = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Google answered HTTP ${res.status}`), { rateLimited: res.status === 429 });
  try { return JSON.parse(raw); } catch { throw new Error('Google answered something that is not JSON'); }
}

/** One retry: Google now and then answers an HTML error page to a call that works a second later. */
async function gRpcRetry(service, body) {
  try { return await gRpc(service, body); } catch (e) { if (e.rateLimited) throw e; await sleep(1500); return gRpc(service, body); }
}

/** The shape of one creative: an image, or Google's own preview page (video, HTML5, text and the rest). */
function googleCreative(c) {
  const body = c?.['3'] ?? {};
  const img = /src="([^"]+)"/.exec(text(body['3']?.['2']));
  const preview = text(body['1']?.['4']);
  return {
    id: text(c?.['2']),
    format: img ? 'image' : preview ? 'rich' : 'other',
    previewUrl: img ? img[1] : preview || null,
    firstShown: iso(c?.['6']?.['1']),
    lastShown: iso(c?.['7']?.['1']),
  };
}

async function google(job, deadline) {
  const out = { status: 'ok', error: null, region: job.googleRegion ?? null, queries: [], candidates: { advertisers: 0, domains: 0 }, withoutAdsInCountry: 0, advertisers: [] };
  if (!job.googleRegion) {
    out.status = 'failed';
    out.error = `no Google region id for ${job.country}: send googleRegion (2000 plus the ISO 3166 number of the country)`;
    return out;
  }
  const advertisers = new Map();
  const domains = new Set();
  let failures = 0;
  let waits = 0;
  let gaveUp = null;
  const note = (m) => { if (!out.notes) out.notes = []; if (out.notes.length < 20) out.notes.push(m); };
  const call = async (service, body) => {
    for (;;) {
      if (gaveUp) throw new Error(gaveUp);
      if (failures >= 4) throw new Error('Google refused or failed four calls in a row; stopped asking');
      await sleep(GOOGLE_PACE_MS);
      try { const r = await gRpcRetry(service, body); failures = 0; return r; } catch (e) {
        if (!e.rateLimited) { failures++; throw e; }
        // Google is limiting this PC: wait it out, twice, then stop asking rather than hold the job. The limit is
        // respected, not worked around; the rest of the result is still returned, labelled.
        const wait = GOOGLE_COOL_MS * 2 ** waits;
        if (waits < 2 && Date.now() + wait < deadline) { waits++; out.rateLimitedWaits = waits; await sleep(wait); continue; }
        gaveUp = `Google answers HTTP 429 (it is limiting this PC's line)${waits ? ` and still did after ${waits} waits` : ''}`;
        out.rateLimited = true;
        failures++; throw new Error(gaveUp);
      }
    }
  };

  for (const q of arr(job.googleQueries)) {
    if (gaveUp) break;
    if (Date.now() > deadline) { out.status = 'partial'; note('time ran out while searching Google suggestions'); break; }
    try {
      const j = await call('SearchService/SearchSuggestions', { 1: q, 2: 25, 3: 25 });
      out.queries.push(q);
      for (const item of arr(j?.['1'])) {
        const a = item?.['1'];
        const d = item?.['2']?.['1'];
        if (a?.['2'] && !advertisers.has(a['2'])) advertisers.set(a['2'], { id: text(a['2']), name: text(a['1']), registeredCountry: text(a['3']) || null, via: new Set([`name:${q}`]) });
        else if (a?.['2']) advertisers.get(a['2']).via.add(`name:${q}`);
        if (d) domains.add(text(d).toLowerCase());
      }
    } catch (e) { out.status = 'partial'; note(`suggestions for "${q}": ${errText(e)}`); }
  }
  out.candidates = { advertisers: advertisers.size, domains: domains.size };

  // Names that carry the industry word first, then this country's own companies: the cap cuts the tail, not these.
  const words = arr(job.terms).flatMap((t) => text(t).toLowerCase().split(/\s+/)).filter(wordLong);
  const named = (a) => words.some((w) => a.name.toLowerCase().includes(w));
  const rank = (a) => (named(a) ? 0 : 2) + (a.registeredCountry === job.country ? 0 : 1);
  const picked = [...advertisers.values()].sort((a, b) => rank(a) - rank(b)).slice(0, Number(job.maxGoogleAdvertisers) || 40);
  const pickedDomains = [...domains].slice(0, Number(job.maxGoogleDomains) || 30);

  const found = new Map(); // advertiser id -> { name, country, creatives: Map, total, domains: Set }
  const keep = (id, name, registeredCountry, via) => {
    if (!found.has(id)) found.set(id, { id, name, registeredCountry: registeredCountry ?? null, creatives: new Map(), total: 0, domains: new Set(), via: new Set() });
    const f = found.get(id);
    if (!f.name && name) f.name = name;
    if (via) f.via.add(via);
    return f;
  };
  // The region filter is field 8 of the search (a list of region ids); field 7 only echoes the page's own region.
  const search = (filter) => ({ 2: 100, 3: { 8: [job.googleRegion], ...filter }, 7: { 1: 1, 2: 30, 3: job.googleRegion } });
  const read = (j, via, domain) => {
    const list = arr(j?.['1']);
    const touched = new Set();
    for (const c of list) {
      const id = text(c?.['1']);
      if (!id) continue;
      const f = keep(id, text(c?.['12']), advertisers.get(id)?.registeredCountry, via);
      const d = text(c?.['14']) || domain;
      if (d) f.domains.add(d.toLowerCase());
      const cr = googleCreative(c);
      if (cr.id && !f.creatives.has(cr.id)) f.creatives.set(cr.id, cr);
      touched.add(id);
    }
    return { touched, count: Number(j?.['4']) || list.length };
  };

  for (const a of picked) {
    if (gaveUp) break;
    if (Date.now() > deadline) { out.status = 'partial'; note('time ran out while reading advertisers'); break; }
    try {
      const j = await call('SearchService/SearchCreatives', search({ 13: { 1: [a.id] } }));
      const { touched, count } = read(j, 'name');
      if (!touched.size) out.withoutAdsInCountry++;
      else found.get(a.id).total = Math.max(found.get(a.id).total, count);
    } catch (e) { out.status = 'partial'; note(`advertiser ${a.name}: ${errText(e)}`); }
  }
  for (const d of pickedDomains) {
    if (gaveUp) break;
    if (Date.now() > deadline) { out.status = 'partial'; note('time ran out while reading websites'); break; }
    try {
      const j = await call('SearchService/SearchCreatives', search({ 12: { 1: d, 2: true } }));
      const { touched, count } = read(j, `domain:${d}`, d);
      // The count covers every advertiser of the website; it is one advertiser's only when it is the only one.
      if (touched.size === 1) { const f = found.get([...touched][0]); f.total = Math.max(f.total, count); }
    } catch (e) { out.status = 'partial'; note(`website ${d}: ${errText(e)}`); }
  }

  const today = Date.now() / 1000;
  out.advertisers = [...found.values()].map((f) => {
    const list = [...f.creatives.values()];
    const formats = { image: 0, rich: 0, other: 0 };
    for (const c of list) formats[c.format]++;
    const firsts = list.map((c) => c.firstShown).filter(Boolean).sort();
    const lasts = list.map((c) => c.lastShown).filter(Boolean).sort();
    const lastShown = lasts.at(-1) ?? null;
    return {
      name: f.name || null, advertiserId: f.id, registeredCountry: f.registeredCountry, websites: [...f.domains].slice(0, 5),
      adsInCountry: Math.max(f.total, list.length), formats,
      firstShown: firsts[0] ?? null, lastShown, activeNow: lastShown ? (Date.parse(lastShown) / 1000) >= today - 7 * DAY : null,
      matchedBy: [...f.via].slice(0, 6),
      url: `${GOOGLE}/advertiser/${f.id}?region=${job.country}`,
      sampleAds: list.sort((a, b) => text(b.lastShown).localeCompare(text(a.lastShown))).slice(0, 6),
      relevance: words.some((w) => text(f.name).toLowerCase().includes(w) || [...f.domains].some((d) => d.includes(w))) ? 'name-match' : 'unconfirmed',
    };
  }).sort((a, b) => (a.relevance === 'name-match' ? 0 : 1) - (b.relevance === 'name-match' ? 0 : 1) || b.adsInCountry - a.adsInCountry);
  if (gaveUp) { out.status = out.advertisers.length ? 'partial' : 'rate-limited'; out.error = gaveUp; }
  if (!out.advertisers.length && out.status === 'ok') out.status = 'empty';
  return out;
}

// --------------------------------------------------------------------- Meta

/** Browsers this run started, by pid, so they are closed however the run ends. */
const running = new Set();

/** The browser and every helper it started: killing only the main process can leave the helpers running. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    else { spawnSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore', timeout: 10_000 }); process.kill(pid, 'SIGKILL'); }
  } catch { /* already gone */ }
}
const killRunning = () => { for (const pid of running) killTree(pid); running.clear(); };
process.on('exit', killRunning);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  if (os.constants.signals[sig]) process.on(sig, () => { killRunning(); process.exit(1); });
}

/** Older than any ads job can run (30 min at most): a browser this old was left by a run that was killed outright. */
const STALE_MS = 35 * 60_000;
const etimeMs = (t) => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim());
  return m ? ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 3600 + +m[3] * 60 + +m[4]) * 1000 : 0;
};

/** Closes headless browsers and profile folders an earlier run could not clean up (the worker kills a timed-out job outright). */
function sweepStale() {
  try {
    if (process.platform === 'win32') {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*lgw-ads-*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { '{0} {1}' -f $_.ProcessId, [int]([DateTime]::Now - $_.CreationDate).TotalSeconds }"],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      for (const line of String(ps.stdout ?? '').split(/\r?\n/)) {
        const [pid, age] = line.trim().split(/\s+/).map(Number);
        if (pid && age * 1000 > STALE_MS) killTree(pid);
      }
    } else {
      const ps = spawnSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 15_000 });
      for (const line of String(ps.stdout ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m && m[3].includes('lgw-ads-') && !m[3].includes('--type=') && etimeMs(m[2]) > STALE_MS) killTree(Number(m[1]));
      }
    }
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('lgw-ads-')) continue;
      const dir = path.join(os.tmpdir(), name);
      try { if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use or gone */ }
    }
  } catch { /* a sweep that fails never stops the job */ }
}

/** A headless browser on a throwaway profile, and a DevTools connection to it. Copies shot.mjs. */
async function launch(exe, deadline) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-ads-'));
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
    '--disable-component-update', '--disable-background-networking', '--disable-default-apps',
    '--disable-features=Translate,msEdgeSidebarV2,msHubApps,msImplicitSignin,EdgeCollections,msShowSignInPrompt',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--lang=en-GB', '--password-store=basic', '--use-mock-keychain',
    '--window-size=1280,900', 'about:blank',
  ];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  if (child.pid) running.add(child.pid);
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  child.on('error', (e) => { exited = e.message; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const until = Math.min(deadline, Date.now() + START_TIMEOUT_MS);
  let lines = null;
  while (Date.now() < until) {
    if (exited !== null) break;
    try {
      lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (lines[0] && lines[1]) break;
    } catch { /* not written yet */ }
    lines = null;
    await sleep(100);
  }
  const close = async (cdp) => {
    try { if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(3000)]); } catch { /* already gone */ }
    try { cdp?.ws.close(); } catch { /* gone */ }
    // Give it a moment to exit by itself, then end the whole tree: helpers can outlive the main process.
    for (let i = 0; i < 15 && exited === null; i++) await sleep(100);
    killTree(child.pid);
    running.delete(child.pid);
    // Windows keeps the profile's files locked for a moment after the browser exits.
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  };
  if (!lines) {
    await close(null);
    throw new Error(exited !== null ? `the browser would not start (${exe} exited: ${exited})` : `the browser did not start within ${START_TIMEOUT_MS / 1000} s (${exe})`);
  }
  const cdp = await connect(`ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`);
  return { cdp, close: () => close(cdp) };
}

/** The DevTools protocol over one WebSocket: send(method, params, sessionId) and on(event, fn). */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    const cdp = {
      ws,
      send(method, params = {}, sessionId) {
        const id = nextId++;
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
    };
    ws.addEventListener('open', () => resolve(cdp));
    ws.addEventListener('error', () => reject(new Error('could not connect to the browser')));
    ws.addEventListener('close', () => {
      for (const p of pending.values()) p.rej(new Error(`the browser closed during ${p.method}`));
      pending.clear();
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.id) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
        return;
      }
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    });
  });
}

/** Every ad (a collated_results entry) and the result count anywhere in a parsed Ad Library answer. */
function walkMeta(node, into) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) walkMeta(v, into); return; }
  if (Array.isArray(node.collated_results)) {
    for (const ad of node.collated_results) if (ad?.ad_archive_id) into.ads.push(ad);
  }
  if (node.search_results_connection && typeof node.search_results_connection === 'object') {
    const c = node.search_results_connection;
    if (Number.isFinite(Number(c.count))) into.count = Number(c.count);
    if (c.page_info) into.pageInfo = c.page_info;
  }
  if (node.xfb_ad_library_is_captcha_required === true) into.captcha = true;
  for (const v of Object.values(node)) walkMeta(v, into);
}

function parseMeta(raw, into) {
  const clean = text(raw).replace(/^for \(;;\);/, '');
  const attempts = [clean, ...clean.split(/\r?\n/)];
  for (const piece of attempts) {
    if (!piece.trim()) continue;
    try { walkMeta(JSON.parse(piece), into); if (piece === clean) return; } catch { /* a line of a multi-part answer, or not JSON */ }
  }
}

/** What an ad's own words give away: contact numbers, prices, hooks, links and (a guess at) the language. */
const HOOKS = ['free', 'percuma', 'discount', 'diskaun', 'promo', 'promotion', 'rebate', 'subsid', 'incentive', 'installment', 'ansuran', 'save', 'jimat',
  'warranty', 'waranti', 'guarantee', 'limited', 'terhad', 'bonus', 'gift', 'hadiah', 'loan', 'financing', 'pembiayaan', 'quotation', 'kuotasi',
  'site visit', 'survey', 'net metering', 'nem', 'seda', 'payback', 'roi', 'zero', 'bil elektrik', 'electricity bill', 'testimoni', 'testimonial',
  '免费', '优惠', '折扣', '省电', '电费', '保修', '保固', '分期', '补贴', '限时', '回报', '免费报价', '免费勘察'];
function extract(raw) {
  const t = text(raw);
  const lower = t.toLowerCase();
  const phones = [...new Set((t.match(/(?:\+\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/g) ?? [])
    .map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => { const d = p.replace(/\D/g, ''); return d.length >= 9 && d.length <= 13 && !/^(19|20)\d\d/.test(d); }))].slice(0, 3);
  const prices = [...new Set((t.match(/(?:RM|MYR|S\$|SGD|US\$|USD|Rp|IDR|THB|\$|€|£)\s?\d[\d,.]*\s?(?:k|K|juta|million)?/g) ?? []).map((x) => x.trim()))].slice(0, 6);
  const percents = [...new Set((t.match(/\d{1,3}\s?%/g) ?? []).map((x) => x.replace(/\s/g, '')))].slice(0, 4);
  const hooks = HOOKS.filter((h) => new RegExp('(^|[^a-z])' + h.replace(/ /g, '\\s') + '([^a-z]|$)', 'i').test(lower));
  const links = [...new Set(t.match(/https?:\/\/[^\s)]+|(?:wa\.me|wa\.link)\/\S+/g) ?? [])].slice(0, 3);
  const malay = (lower.match(/\b(yang|dan|untuk|dengan|anda|kami|sekarang|rumah|tenaga|pasang|jimat|bil|sila|hubungi|percuma)\b/g) ?? []).length;
  const language = /[\u4e00-\u9fff]/.test(t) ? 'chinese' : malay >= 2 ? 'malay' : /[a-z]/i.test(t) ? 'english' : 'unknown';
  return { phones, prices, percents, hooks, links, language };
}

/** One ad, cut down to what research needs. */
function metaAd(ad) {
  const s = ad.snapshot ?? {};
  const card = arr(s.cards)[0] ?? {};
  const link = text(s.link_url || card.link_url);
  const body = text(s.body?.text || card.body).replace(/\s+/g, ' ').trim();
  const headline = text(s.title || card.title).replace(/\s+/g, ' ').trim();
  const url = (v) => { const u = text(v); return /^https?:\/\//.test(u) ? u : null; };
  const videoPreview = url(arr(s.videos)[0]?.video_preview_image_url) || url(arr(s.cards).find((c) => c.video_preview_image_url)?.video_preview_image_url);
  const images = [...new Set([...arr(s.images).map((i) => url(i.resized_image_url) || url(i.original_image_url)),
    ...arr(s.cards).map((c) => url(c.resized_image_url) || url(c.original_image_url))].filter(Boolean))].slice(0, 4);
  return {
    id: text(ad.ad_archive_id), pageId: text(ad.page_id), pageName: text(ad.page_name || s.page_name),
    pageUrl: text(s.page_profile_uri) || null, likes: Number.isFinite(Number(s.page_like_count)) ? Number(s.page_like_count) : null,
    categories: arr(s.page_categories).map(text), active: ad.is_active === true,
    start: iso(ad.start_date), end: iso(ad.end_date), platforms: arr(ad.publisher_platform).map(text),
    format: text(s.display_format) || null,
    headline: headline.slice(0, 200) || null,
    text: body.slice(0, 1500) || null, cta: text(s.cta_text || card.cta_text) || null, ctaType: text(s.cta_type || card.cta_type) || null,
    images, videoPreview, image: images[0] ?? videoPreview ?? null, hasVideo: arr(s.videos).length > 0 || !!videoPreview,
    cards: arr(s.cards).length > 1 ? arr(s.cards).slice(0, 6).map((c) => ({ title: text(c.title).slice(0, 120) || null, body: text(c.body).slice(0, 200) || null, link: url(c.link_url)?.slice(0, 300) ?? null, cta: text(c.cta_text) || null, image: url(c.resized_image_url) || url(c.original_image_url) })) : [],
    byline: text(s.byline) || null, linkDescription: text(s.link_description || card.link_description).slice(0, 300) || null,
    extraLinks: arr(s.extra_links).map(text).filter(Boolean).slice(0, 3), pageImage: url(s.page_profile_picture_url),
    extracted: extract(body + ' ' + headline),
    link: link ? link.slice(0, 300) : null, domain: host(link) || text(s.caption).toLowerCase() || null,
    versions: Number(ad.collation_count) || 1,
    url: `https://www.facebook.com/ads/library/?id=${text(ad.ad_archive_id)}`,
  };
}

function libraryUrl(job, term) {
  const u = new URL('https://www.facebook.com/ads/library/');
  u.searchParams.set('active_status', job.activeOnly === false ? 'all' : 'active');
  u.searchParams.set('ad_type', 'all');
  u.searchParams.set('country', job.country);
  u.searchParams.set('media_type', 'all');
  u.searchParams.set('q', term);
  u.searchParams.set('search_type', 'keyword_unordered');
  return u.href;
}

/** What the Ad Library shows for one search term: scrolls until `limit` ads, the end, or the deadline. */
async function metaTerm(cdp, job, term, limit, deadline) {
  const got = { ads: [], count: null, pageInfo: null, captcha: false };
  const seen = new Set();
  const take = (into) => { for (const ad of into.ads) if (!seen.has(ad.ad_archive_id)) { seen.add(ad.ad_archive_id); got.ads.push(ad); } };
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    const graphql = new Map();
    const wires = [];
    cdp.on('Network.responseReceived', (p, sid) => {
      if (sid === sessionId && /\/api\/graphql\/?/.test(p.response.url)) graphql.set(p.requestId, true);
    });
    cdp.on('Network.loadingFinished', (p, sid) => {
      if (sid !== sessionId || !graphql.has(p.requestId)) return;
      graphql.delete(p.requestId);
      wires.push(send('Network.getResponseBody', { requestId: p.requestId }).then((b) => {
        const into = { ads: [], count: null, pageInfo: null, captcha: false };
        parseMeta(b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body, into);
        if (into.pageInfo) got.pageInfo = into.pageInfo;
        if (into.count != null && got.count == null) got.count = into.count;
        take(into);
      }).catch(() => {}));
    });
    await send('Network.enable');
    await send('Page.enable');
    const { userAgent } = await cdp.send('Browser.getVersion');
    await send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace(/Headless/g, ''), acceptLanguage: 'en-GB,en;q=0.9' });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.navigate', { url: libraryUrl(job, term) });

    // The first page of ads is inside the page: wait for it.
    const evalJson = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    let first = false;
    for (let i = 0; !first && Date.now() < deadline && i < 80; i++) {
      await sleep(500);
      let scripts = null;
      try {
        scripts = await evalJson(`[...document.querySelectorAll('script[type="application/json"]')].map(s => s.textContent).filter(t => t.includes('search_results_connection'))`);
      } catch { /* the page is still navigating */ }
      if (arr(scripts).length) {
        const into = { ads: [], count: null, pageInfo: null, captcha: false };
        for (const s of scripts) parseMeta(s, into);
        if (into.pageInfo) got.pageInfo = into.pageInfo;
        if (into.count != null) got.count = into.count;
        if (into.captcha) got.captcha = true;
        take(into);
        first = true;
      }
    }
    if (!first) {
      let page = {};
      try { page = await evalJson(`({ title: document.title, text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200), url: location.href })`); } catch { /* gone */ }
      got.blocked = { reason: 'the Ad Library page did not show its ads', ...page };
      return got;
    }
    if (got.captcha) { got.blocked = { reason: 'the Ad Library asked for a captcha' }; return got; }

    // Scrolling makes the page ask for the next ads; read them off the wire.
    let stale = 0;
    while (got.ads.length < limit && Date.now() < deadline && stale < 4 && got.pageInfo?.has_next_page !== false) {
      const before = got.ads.length;
      try { await evalJson(`window.scrollTo(0, document.documentElement.scrollHeight), true`); } catch { break; }
      await sleep(2500);
      await Promise.allSettled(wires.splice(0));
      stale = got.ads.length > before ? 0 : stale + 1;
    }
    await Promise.allSettled(wires.splice(0));
    return got;
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

function sameWords(job) {
  return arr(job.terms).flatMap((t) => text(t).toLowerCase().split(/\s+/)).filter(wordLong);
}

async function meta(job, deadline) {
  const out = { status: 'ok', error: null, terms: [], totalResults: null, adsRead: 0, advertisers: [] };
  if (!job.browser || !fs.existsSync(job.browser)) {
    out.status = 'no-browser';
    out.error = `no browser on this worker (${job.browser || 'none set'}); Meta's Ad Library needs one. Google's side is still returned.`;
    return out;
  }
  const terms = arr(job.terms).map(text).filter(Boolean).slice(0, Number(job.maxMetaTerms) || 3);
  const total = Math.max(10, Number(job.maxMetaAds) || 150);
  let browser;
  const ads = new Map();
  try {
    sweepStale();
    browser = await launch(job.browser, deadline);
    for (let i = 0; i < terms.length; i++) {
      const left = terms.length - i;
      const share = Math.max(10, Math.ceil((total - ads.size) / left));
      const until = Math.min(deadline, Date.now() + Math.max(20_000, (deadline - Date.now()) / left));
      let got;
      try { got = await metaTerm(browser.cdp, job, terms[i], share, until); } catch (e) {
        out.status = 'partial'; out.error = out.error ?? `term "${terms[i]}": ${errText(e)}`; continue;
      }
      out.terms.push({ term: terms[i], totalResults: got.count, adsRead: got.ads.length, blocked: got.blocked ?? null });
      if (got.blocked) { out.status = 'partial'; out.error = out.error ?? `term "${terms[i]}": ${got.blocked.reason}`; }
      if (out.totalResults == null || (got.count ?? 0) > out.totalResults) out.totalResults = got.count ?? out.totalResults;
      for (const ad of got.ads) if (!ads.has(ad.ad_archive_id)) ads.set(ad.ad_archive_id, metaAd(ad));
    }
  } catch (e) {
    out.status = ads.size ? 'partial' : 'failed';
    out.error = errText(e);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  out.adsRead = ads.size;
  if (!ads.size && out.status === 'ok') out.status = 'empty';
  if (!ads.size && out.status === 'partial') out.status = 'failed';

  const words = sameWords(job);
  const about = (t) => words.some((w) => text(t).toLowerCase().includes(w));
  const pages = new Map();
  for (const ad of ads.values()) {
    const key = ad.pageId || ad.pageName;
    if (!pages.has(key)) pages.set(key, []);
    pages.get(key).push(ad);
  }
  out.advertisers = [...pages.values()].map((list) => {
    const first = list[0];
    const starts = list.map((a) => a.start).filter(Boolean).sort();
    const count = (pick) => { const m = {}; for (const a of list) for (const v of arr(pick(a))) if (v) m[v] = (m[v] ?? 0) + 1; return m; };
    const industryAds = list.filter((a) => about(a.headline) || about(a.text) || about(a.domain)).length;
    const nameMatch = about(first.pageName);
    const longest = starts[0] ? Math.max(0, Math.round((Date.now() - Date.parse(starts[0])) / (DAY * 1000))) : null;
    const sum = (pick) => { const m = {}; for (const a of list) for (const v of arr(pick(a.extracted ?? {}))) if (v) m[v] = (m[v] ?? 0) + 1; return m; };
    const recent = list.filter((a) => a.start && Date.parse(a.start) >= Date.now() - 30 * DAY * 1000).length;
    const oldest = [...list].sort((a, b) => text(a.start).localeCompare(text(b.start)));
    const newest = [...oldest].reverse();
    const sample = [];
    for (const ad of [...oldest.slice(0, 3), ...newest]) if (sample.length < 6 && !sample.includes(ad)) sample.push(ad);
    return {
      pageName: first.pageName || null, pageId: first.pageId || null, pageUrl: first.pageUrl, likes: first.likes, categories: first.categories, pageImage: first.pageImage,
      contacts: sum((e) => e.phones), prices: sum((e) => e.prices), percents: sum((e) => e.percents), hooks: sum((e) => e.hooks), languages: sum((e) => [e.language]),
      adsWithVideo: list.filter((a) => a.hasVideo).length, startedLast30Days: recent, byline: first.byline,
      adsSeen: list.length, activeAds: list.filter((a) => a.active).length, industryAds,
      relevance: nameMatch ? 'name-match' : industryAds >= 2 ? 'ads-mention' : 'unconfirmed',
      firstStarted: starts[0] ?? null, lastStarted: starts.at(-1) ?? null, longestRunningDays: longest,
      formats: count((a) => a.format), platforms: count((a) => a.platforms), ctas: count((a) => a.cta), websites: count((a) => a.domain),
      libraryUrl: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${job.country}&view_all_page_id=${first.pageId}`,
      // The three longest-running ads (an ad that runs for months is the one that pays), then the newest.
      sampleAds: sample,
    };
  }).sort((a, b) => ({ 'name-match': 0, 'ads-mention': 1, unconfirmed: 2 })[a.relevance] - ({ 'name-match': 0, 'ads-mention': 1, unconfirmed: 2 })[b.relevance]
    || b.industryAds - a.industryAds || b.adsSeen - a.adsSeen);
  // Every ad read, not only the samples: the analysis (analyze.mjs) labels each one.
  out.ads = [...ads.values()];
  return out;
}

// ------------------------------------------------------------------- joined

/** One list over both sources: the same company on both is one row, found by name or by website. */
function join(g, m) {
  const rows = new Map();
  const find = (name, sites) => {
    const key = nameKey(name);
    for (const [k, r] of rows) {
      if (key && (k === key || (key.length >= 5 && k.length >= 5 && (k.includes(key) || key.includes(k))))) return r;
      if (sites.some((s) => r.websites.has(s))) return r;
    }
    return null;
  };
  const add = (name, sites) => {
    let r = find(name, sites);
    if (!r) { r = { name, key: nameKey(name), websites: new Set(), google: null, meta: null }; rows.set(r.key || name, r); }
    for (const s of sites) if (s) r.websites.add(s);
    return r;
  };
  for (const a of g.advertisers) add(a.name, a.websites).google = a;
  for (const a of m.advertisers) add(a.pageName, Object.keys(a.websites)).meta = a;
  return [...rows.values()].map((r) => {
    const gAds = r.google?.adsInCountry ?? 0;
    const mAds = r.meta?.adsSeen ?? 0;
    const confirmed = r.google?.relevance === 'name-match' || r.meta?.relevance === 'name-match' || r.meta?.relevance === 'ads-mention';
    return {
      name: r.name, platforms: [r.google ? 'google' : null, r.meta ? 'meta' : null].filter(Boolean),
      googleAds: gAds, metaAds: mAds, metaActiveAds: r.meta?.activeAds ?? 0,
      websites: [...r.websites].slice(0, 5), relevance: confirmed ? 'about-the-industry' : 'unconfirmed',
      google: r.google ? { advertiserId: r.google.advertiserId, activeNow: r.google.activeNow, firstShown: r.google.firstShown, lastShown: r.google.lastShown, url: r.google.url } : null,
      meta: r.meta ? { pageId: r.meta.pageId, pageUrl: r.meta.pageUrl, likes: r.meta.likes, longestRunningDays: r.meta.longestRunningDays, libraryUrl: r.meta.libraryUrl } : null,
    };
  }).sort((a, b) => (a.relevance === 'about-the-industry' ? 0 : 1) - (b.relevance === 'about-the-industry' ? 0 : 1)
    || b.platforms.length - a.platforms.length || (b.googleAds + b.metaAds) - (a.googleAds + a.metaAds));
}

// ------------------------------------------------------------------- the job

async function run(job) {
  const started = Date.now();
  const deadline = started + Math.max(30_000, Number(job.timeoutMs || 600_000) - 30_000);
  const [g, m] = await Promise.all([
    google(job, deadline).catch((e) => ({ status: 'failed', error: errText(e), advertisers: [] })),
    meta(job, deadline).catch((e) => ({ status: 'failed', error: errText(e), advertisers: [], adsRead: 0 })),
  ]);
  let advertisers = [];
  try { advertisers = join(g, m); } catch (e) { advertisers = []; g.joinError = errText(e); }
  const notes = [];
  if (g.status !== 'ok') notes.push(`Google Ads Transparency Center: ${g.status}${g.error ? ` (${g.error})` : ''}`);
  if (m.status !== 'ok') notes.push(`Meta Ad Library: ${m.status}${m.error ? ` (${m.error})` : ''}`);
  return {
    country: job.country, countryName: job.countryName ?? null, industry: job.industry, terms: arr(job.terms),
    startedAt: new Date(started).toISOString(), tookMs: Date.now() - started,
    summary: {
      advertisers: advertisers.length,
      onBothPlatforms: advertisers.filter((a) => a.platforms.length === 2).length,
      aboutTheIndustry: advertisers.filter((a) => a.relevance === 'about-the-industry').length,
      googleAdvertisers: g.advertisers.length, metaAdvertisers: m.advertisers.length, metaAdsRead: m.adsRead ?? 0, metaTotalResults: m.totalResults ?? null,
    },
    notes, advertisers, google: g, meta: m,
  };
}

try {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = await run(job);
  process.stdout.write('\n' + JSON.stringify({ ok: true, result }) + '\n', () => process.exit(0));
} catch (e) {
  process.stdout.write('\n' + JSON.stringify({ ok: false, error: errText(e) }) + '\n', () => process.exit(0));
}
