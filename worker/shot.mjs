// One web.shot job: a proof screenshot of one page, taken on this PC's own line
// with the browser already on it (Microsoft Edge on Windows, Google Chrome on a
// Mac). The worker runs this with its portable Node, once per job, with the
// job's payload in a JSON file, and reads one JSON line from stdout.
//
// No browser download and no npm package: the browser is started headless with
// a throwaway profile and driven over the DevTools protocol with Node's own
// WebSocket. What it does copies company-diver's shots.ts: desktop 1280x760 or
// mobile 390x780 at scale 2, an optional `find` text outlined in red and
// scrolled to the centre, and a JPEG of the viewport.
//
// A bot check (Cloudflare "Just a moment...", Turnstile, reCAPTCHA and the like)
// is never answered: the job comes back `blocked: true` with the evidence in
// `detail`, and no image. An error page (4xx, 5xx) is shot like any page.
//
// The URL comes from an API caller and this runs inside someone's home or
// office, so every request the page makes, redirects included, must go to a
// public address; the rest are refused before they leave the browser.
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEVICES = {
  desktop: { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 780, deviceScaleFactor: 2, mobile: true },
};
const OUTLINE_PAUSE_MS = 400;
const START_TIMEOUT_MS = 20_000;

class Refused extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ public addresses

const PRIVATE = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['::', 127], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE.addSubnet(ip, bits, 'ipv6');
}

function isPublic(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return !PRIVATE.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

const verdicts = new Map();
/** Resolves to null when every address of the host is public, else the reason it is refused. */
function hostVerdict(host) {
  host = host.replace(/^\[|\]$/g, '');
  if (!verdicts.has(host)) {
    verdicts.set(host, (async () => {
      if (net.isIP(host)) return isPublic(host) ? null : `${host} is a private or local address`;
      if (host === 'localhost' || host.endsWith('.localhost')) return `${host} is a local address`;
      let all;
      try { all = await dns.lookup(host, { all: true, verbatim: true }); } catch (e) { return `${host} does not resolve (${e.code ?? e.message})`; }
      const bad = all.find((a) => !isPublic(a.address));
      return bad ? `${host} is a private or local address (${bad.address}); workers read only public sites` : null;
    })());
  }
  return verdicts.get(host);
}

// ---------------------------------------------------------------- the browser

/** A headless browser on a throwaway profile, and a DevTools connection to it. */
async function launch(exe, device, deadline) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-shot-'));
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
    '--disable-component-update', '--disable-background-networking', '--disable-default-apps',
    '--disable-features=Translate,msEdgeSidebarV2,msHubApps,msImplicitSignin,EdgeCollections,msShowSignInPrompt',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--lang=en-GB', '--password-store=basic', '--use-mock-keychain',
    `--window-size=${device.width},${device.height}`, 'about:blank',
  ];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
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
    cdp?.ws.close();
    if (exited === null) { try { child.kill(); } catch { /* gone */ } }
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
      const msg = JSON.parse(String(e.data));
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

// --------------------------------------------------------------- in the page

/** Runs in the page: what a bot check would show. */
function pageFacts() {
  const html = document.documentElement ? document.documentElement.outerHTML.slice(0, 300000) : '';
  const text = (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ').trim();
  return { title: document.title || '', href: location.href, html, textLength: text.length, text: text.slice(0, 300) };
}

/** Runs in the page: outline the first visible element holding `needle`. Copies shots.ts. */
function outline(needle) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ');
  const want = norm(needle).trim().slice(0, 60);
  if (!want || !document.body) return false;
  const visible = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const mark = (el) => {
    el.style.outline = '4px solid #e11d48';
    el.style.outlineOffset = '4px';
    el.style.background = 'rgba(225, 29, 72, 0.10)';
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  };
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (!norm(n.nodeValue).includes(want)) continue;
    if (visible(n.parentElement)) return mark(n.parentElement);
  }
  // Text split across elements ("Call <b>us</b> now"): the deepest visible element of the first match.
  let best = null;
  for (const el of document.body.querySelectorAll('*')) {
    if (best && !best.contains(el)) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    if (!norm(el.textContent).includes(want) || !visible(el)) continue;
    best = el;
  }
  return best ? mark(best) : false;
}

// ----------------------------------------------------------------- bot checks

const CHALLENGE_TITLE = /^\s*(just a moment|attention required|please wait\b|verifying you are human|verify you are human|checking your browser|checking if the site connection is secure|ddos-guard|one more step|security check|are you a robot|human verification|pardon our interruption|access to this page has been denied)/i;
const MARKERS = [
  ['cloudflare challenge', /window\._cf_chl_opt|id="challenge-form"|cf-chl-widget|\/cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate/i],
  ['imperva / incapsula', /_Incapsula_Resource|Incapsula incident ID/i],
  ['datadome', /captcha-delivery\.com/i],
  ['perimeterx', /px-captcha|_pxCaptcha/i],
  ['akamai', /errors\.edgesuite\.net/i],
  ['google sorry page', /\/sorry\/index|unusual traffic from your computer network/i],
];
/** Captcha widgets: a page made of little else is a bot check; a long page with a form that has one is not. */
const WIDGETS = [
  ['turnstile', /challenges\.cloudflare\.com\/turnstile|class="cf-turnstile/i],
  ['recaptcha', /google\.com\/recaptcha\/api2\/anchor|recaptcha\/api2\/bframe|class="g-recaptcha"/i],
  ['hcaptcha', /hcaptcha\.com\/captcha|class="h-captcha"/i],
];
const SHORT_PAGE = 1000;

/** Evidence that this page is a bot check, or null. */
function botCheck(facts, response) {
  const found = [];
  const mitigated = response?.headers?.['cf-mitigated'];
  if (mitigated) found.push(`header cf-mitigated: ${mitigated}`);
  if (CHALLENGE_TITLE.test(facts.title)) found.push(`title "${facts.title.trim().slice(0, 80)}"`);
  for (const [name, re] of MARKERS) if (re.test(facts.html)) found.push(name);
  if (facts.textLength < SHORT_PAGE) for (const [name, re] of WIDGETS) if (re.test(facts.html)) found.push(`${name} on a short page`);
  if (!found.length) return null;
  return {
    evidence: found, title: facts.title || null, url: facts.href, status: response?.status ?? null,
    server: response?.headers?.server ?? null, text: facts.text,
  };
}

// ------------------------------------------------------------------- the job

async function shot(job) {
  const started = Date.now();
  const deadline = started + Math.max(15_000, Number(job.timeoutMs || 90_000) - 5_000);
  const device = DEVICES[job.device === 'mobile' ? 'mobile' : 'desktop'];
  const waitMs = Math.max(0, Math.min(30_000, Number(job.waitMs ?? 1500)));
  const quality = Math.max(1, Math.min(100, Math.round(Number(job.quality ?? 72))));
  const find = typeof job.find === 'string' && job.find.trim() ? job.find : null;
  let url;
  try { url = new URL(String(job.url ?? '')); } catch { throw new Refused(`not a URL: ${job.url}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused(`only http and https URLs: ${url.href}`);
  const refused = await hostVerdict(url.hostname);
  if (refused) throw new Refused(refused);
  if (!job.browser || !fs.existsSync(job.browser)) throw new Refused(`no browser on this worker (${job.browser || 'none set'})`);

  const browser = await launch(job.browser, device, deadline);
  try {
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);

    // Every request the page makes, the page itself and its redirects included, goes only to public addresses.
    const refusedRequests = [];
    cdp.on('Fetch.requestPaused', async (p, sid) => {
      if (sid !== sessionId) return;
      let reason = null;
      try {
        const u = new URL(p.request.url);
        if (u.protocol === 'http:' || u.protocol === 'https:') reason = await hostVerdict(u.hostname);
        else if (u.protocol !== 'data:' && u.protocol !== 'blob:') reason = `${u.protocol} is not allowed`;
      } catch { reason = 'not a URL'; }
      if (reason) refusedRequests.push({ url: p.request.url.slice(0, 200), reason, document: p.resourceType === 'Document' });
      const next = reason ? send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'AddressUnreachable' })
        : send('Fetch.continueRequest', { requestId: p.requestId });
      next.catch(() => {});
    });
    let mainFrame = null;
    let response = null;
    const hops = [];
    // Every page the tab was sent, in order: a challenge that clears itself still shows here.
    const documents = [];
    let challenged = null;
    cdp.on('Network.requestWillBeSent', (p, sid) => {
      if (sid !== sessionId || p.type !== 'Document' || (mainFrame && p.frameId !== mainFrame)) return;
      if (p.redirectResponse) hops.push({ url: p.redirectResponse.url, status: p.redirectResponse.status, location: p.request.url });
    });
    cdp.on('Network.responseReceived', (p, sid) => {
      if (sid !== sessionId || p.type !== 'Document' || (mainFrame && p.frameId !== mainFrame)) return;
      const headers = {};
      for (const [k, v] of Object.entries(p.response.headers ?? {})) headers[k.toLowerCase()] = String(v);
      response = { url: p.response.url, status: p.response.status, headers };
      documents.push({ url: response.url, status: response.status });
      // Cloudflare marks its challenge pages. Stop there: the challenge is never left to run and clear itself.
      if (headers['cf-mitigated'] && !challenged) {
        challenged = response;
        send('Page.stopLoading').catch(() => {});
      }
    });
    let loaded = false;
    cdp.on('Page.loadEventFired', (_, sid) => { if (sid === sessionId) loaded = true; });

    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Network.enable');
    await send('Page.enable');
    const { userAgent } = await cdp.send('Browser.getVersion');
    // The browser as a person runs it: no "Headless" in its name, a phone's for a phone.
    const major = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent)?.[1] ?? '141';
    const ua = device.mobile
      ? `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
      : userAgent.replace(/Headless/g, '');
    await send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-GB,en;q=0.9' });
    await send('Emulation.setDeviceMetricsOverride', {
      width: device.width, height: device.height, deviceScaleFactor: device.deviceScaleFactor, mobile: device.mobile,
    });
    if (device.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // The same shot whatever this PC's own theme is.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    const nav = await send('Page.navigate', { url: url.href });
    mainFrame = nav.frameId;
    if (nav.errorText) {
      const own = refusedRequests.find((r) => r.document);
      throw new Refused(own ? own.reason : `the page did not load (${nav.errorText})`);
    }
    // The load event, leaving time for the wait and the shot itself.
    const loadBy = deadline - waitMs - 5_000;
    while (!loaded && !challenged && Date.now() < loadBy) await sleep(100);
    if (challenged) await sleep(300);
    if (!loaded && !response) throw new Refused(`the page did not load within ${Math.round((Date.now() - started) / 1000)} s`);

    const look = async () => (await send('Runtime.evaluate', { expression: `(${pageFacts})()`, returnByValue: true })).result.value;
    const base = () => ({
      url: job.url, finalUrl: response?.url ?? url.href, status: response?.status ?? null, device: job.device === 'mobile' ? 'mobile' : 'desktop',
      title: null, found: false, blocked: false, detail: null, image: null, width: device.width, height: device.height,
      loaded, redirects: hops, documents, refusedRequests: refusedRequests.length ? refusedRequests.slice(0, 20) : undefined,
    });
    // A bot check is looked for as soon as the page has loaded, before it has time to clear itself: never waited out.
    let facts = await look();
    let check = botCheck(facts, challenged ?? response);
    if (!check) {
      await sleep(waitMs);
      facts = await look();
      check = botCheck(facts, challenged ?? response);
    }
    if (check) {
      return { ...base(), finalUrl: challenged?.url ?? facts.href, status: (challenged ?? response)?.status ?? null, title: facts.title || null,
        blocked: true, detail: check, tookMs: Date.now() - started };
    }

    let found = false;
    if (find) {
      found = (await send('Runtime.evaluate', { expression: `(${outline})(${JSON.stringify(find)})`, returnByValue: true })).result.value === true;
      await sleep(OUTLINE_PAUSE_MS);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false });
    return { ...base(), finalUrl: facts.href, title: facts.title || null, found, image: data, tookMs: Date.now() - started };
  } finally {
    await browser.close();
  }
}

try {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = await shot(job);
  process.stdout.write('\n' + JSON.stringify({ ok: true, result }) + '\n', () => process.exit(0));
} catch (e) {
  const error = e instanceof Refused ? e.message : `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
  process.stdout.write('\n' + JSON.stringify({ ok: false, error }) + '\n', () => process.exit(0));
}
