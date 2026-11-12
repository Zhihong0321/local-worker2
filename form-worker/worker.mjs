// Form Worker: this PC or Mac does the two website jobs the hub cannot do from Railway.
//
//   1. Form check (scan): the hub hands out Malaysian lead websites; this worker reads the homepage
//      and its contact pages and returns the form verdict (scan.mjs). Only verdicts go back.
//   2. Form send (send): the hub hands out one contact-form message at a time, with the exact subject,
//      message and sender it logged; this worker fills the form with the browser on this machine
//      (send.mjs) and returns the outcome, the boxes it filled and a screenshot.
//
// Only outbound requests. The hub keeps the records and the LLM keys; the LLM step for boxes the
// script cannot place is asked over /api/form-send/worker/assist. The worker holds the worker key
// (GMAP_WORKER_KEY, the same one the Step 2 Worker uses), never the hub's LAB_TOKEN.
//
// Settings (first found wins): the file FORM_WORKER_ENV names, ./worker.env beside this script,
// then the data folder (Windows %LOCALAPPDATA%\FormWorker, macOS ~/Library/Application Support/FormWorker):
//   LAB_URL=https://ee-auto.up.railway.app
//   GMAP_WORKER_KEY=...          (or LAB_TOKEN=... on a machine that already holds it)
//   WORKER_NAME=form-<name>      (optional; letters, digits, dot, dash)
//   FORM_JOBS=scan,send          (optional; either one alone on a machine that should do only that)
//   CONCURRENCY=6                (optional: sites checked at once)
//   SEND_LANES=4                 (optional: forms filled at once)
//   CHROME_PATH=...              (optional: the browser to use for sending)
// Environment variables with the same names win over the file, for a run started by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWebsite } from './scan.mjs';
import { deliver, browserPath } from './send.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'FormWorker')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'FormWorker')
    : path.join(os.homedir(), '.form-worker');
const LOG = path.join(DATA, 'worker.log');
fs.mkdirSync(DATA, { recursive: true });

function log(message) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${message}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5_000_000) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, line + '\n');
  } catch { /* the console still has it */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const ENV_FILE = process.env.FORM_WORKER_ENV
  ?? [path.join(HERE, 'worker.env'), path.join(DATA, 'worker.env')].find((f) => fs.existsSync(f));
const file = readEnvFile(ENV_FILE);
const pick = (name) => process.env[name] || file[name] || '';

const LAB_URL = pick('LAB_URL').replace(/\/+$/, '');
const KEY = pick('GMAP_WORKER_KEY') || pick('LAB_TOKEN');
const WORKER = pick('WORKER_NAME') || 'form-' + os.hostname().toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
const JOBS = new Set((pick('FORM_JOBS') || 'scan,send').split(',').map((s) => s.trim()).filter(Boolean));
const SCAN_LANES = Math.max(1, Math.min(20, Number(pick('CONCURRENCY')) || 6));
const SEND_LANES = Math.max(1, Math.min(8, Number(pick('SEND_LANES')) || 4));
const SCAN_IDLE_MS = 60_000;
const SEND_IDLE_MS = 20_000;
// A site that keeps its check running this long is left with an unreachable verdict; a form that
// keeps the browser busy this long is left with a failed outcome. The next one goes on.
const SCAN_STALL_MS = 3 * 60_000;
const SEND_FROZEN_MS = 4 * 60_000;
// One hub request that gets no answer in a minute is dropped, so the caller can try again.
const HUB_MS = 60_000;

/** One POST to the hub. Throws with the hub's status when it refuses. */
async function post(route, body) {
  const res = await fetch(LAB_URL + route, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HUB_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Sends a result to the hub. Three tries, with a longer rest before each retry; then the lease ends it. */
async function report(route, body, what) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await post(route, body);
      return true;
    } catch (err) {
      log(`could not report ${what}: ${err.message}`);
      await sleep(10_000 * attempt);
    }
  }
  return false;
}

/** Resolves with the work, or with the fallback after `ms`. The work is never cancelled, only left behind. */
function within(work, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work.catch((err) => ({ ...fallback, detail: `${fallback.detail} (${String(err?.message ?? err).slice(0, 200)})` })), late])
    .finally(() => clearTimeout(timer));
}

// ---- form check -------------------------------------------------------------

async function scanLane() {
  for (;;) {
    let sites = [];
    try {
      sites = (await post('/api/form-scan/worker/take', { worker: WORKER, limit: 1 })).sites ?? [];
    } catch (err) {
      log('could not ask the hub for websites to check: ' + err.message);
    }
    if (!sites.length) { await sleep(SCAN_IDLE_MS); continue; }
    for (const site of sites) {
      const name = site.company_name ?? site.company_id;
      const verdict = await within(
        scanWebsite(site.website),
        SCAN_STALL_MS,
        { status: 'unreachable', url: null, detail: `the check of the site took over ${SCAN_STALL_MS / 60_000} minutes; left it and moved on` },
      );
      log(`site ${name}: ${verdict.status}${verdict.detail ? ` (${verdict.detail})` : ''}`);
      await report('/api/form-scan/worker/done', { worker: WORKER, company_id: site.company_id, form: verdict }, `the check of ${name}`);
    }
  }
}

// ---- form send ----------------------------------------------------------------

async function sendLane() {
  for (;;) {
    let forms = [];
    try {
      forms = (await post('/api/form-send/worker/take', { worker: WORKER, limit: 1 })).forms ?? [];
    } catch (err) {
      log('could not ask the hub for forms to send: ' + err.message);
    }
    if (!forms.length) { await sleep(SEND_IDLE_MS); continue; }
    for (const f of forms) {
      const frozen = {
        status: 'failed',
        website: f.website ?? '',
        form_url: null,
        detail: `the website kept the browser busy for ${SEND_FROZEN_MS / 60_000} minutes; left it and moved on`,
        filled: [], pages_checked: [], screenshot: null, finished_at: new Date().toISOString(),
      };
      const result = await within(
        deliver({
          lead: { company_name: f.company_name, website: f.website },
          sender: f.sender,
          subject: f.subject,
          message: f.body,
          // The LLM step runs on the hub (its keys live there); no answer means the script's fill stands.
          assist: async (req) => {
            try {
              return (await post('/api/form-send/worker/assist', { worker: WORKER, ...req })).fills ?? null;
            } catch (err) {
              log(`llm step for ${f.company_name} gave no answer: ${String(err.message).slice(0, 120)}`);
              return null;
            }
          },
        }),
        SEND_FROZEN_MS,
        frozen,
      );
      log(`form ${f.company_name}: ${result.status} (${result.detail})`);
      const { status, detail, form_url, filled, screenshot } = result;
      await report('/api/form-send/worker/done', {
        worker: WORKER, company_id: f.company_id,
        result: { status, detail, form_url, filled, screenshot },
      }, `the form for ${f.company_name}`);
    }
  }
}

async function main() {
  if (!LAB_URL || !KEY) {
    log(`no LAB_URL, or no GMAP_WORKER_KEY or LAB_TOKEN, in ${ENV_FILE ?? path.join(HERE, 'worker.env')}; nothing to do`);
    process.exit(2);
  }
  const wantSend = JOBS.has('send');
  const browser = wantSend ? browserPath() : null;
  // Without a browser this machine cannot fill forms. It then takes no send work, so no lead is marked failed for it.
  const sending = wantSend && Boolean(browser);
  if (wantSend && !browser) log('no browser found (set CHROME_PATH): this worker takes no form-send work');
  const jobs = [JOBS.has('scan') ? 'form check' : null, sending ? 'form send' : null].filter(Boolean);
  if (!jobs.length) {
    log(`nothing to do with FORM_JOBS=${[...JOBS].join(',')} on this machine`);
    process.exit(2);
  }
  log(`Form Worker ${WORKER}: ${jobs.join(' and ')}; hub ${LAB_URL}; ${SCAN_LANES} sites and ${SEND_LANES} forms at a time${sending ? `; browser ${browser}` : ''}`);
  const lanes = [];
  if (JOBS.has('scan')) for (let i = 0; i < SCAN_LANES; i++) lanes.push(scanLane());
  if (sending) for (let i = 0; i < SEND_LANES; i++) lanes.push(sendLane());
  await Promise.all(lanes);
}

main().catch((err) => {
  log('the worker stopped: ' + (err?.stack ?? err));
  process.exit(1);
});
