// Local Gmap Worker API service. Callers post a Maps scan or a page fetch;
// Windows PCs running worker/worker.ps1 claim it, read Google Maps or the page
// on their own internet line, and post the result back. Nothing scrapes from
// here: this is only the queue between the two, so it runs fine on a small
// Railway service.
//
// TWO KEYS. Callers hold API_KEY. A worker PC holds WORKER_KEY, an HMAC of
// API_KEY, which reaches only the claim, heartbeat, result and strategy routes.
// Rotating API_KEY rotates it; the PCs then need a fresh package.
//
// Jobs live in memory. A restart loses the queue, but not a scan in progress:
// the worker sends the job's payload with its result, and an id the service no
// longer knows is filed again as done, so a caller polling that id still gets it.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strategy, DEFAULT_MAX, MAX_LIMIT } from './strategy.mjs';
import { packageZip, PACKAGE_NAME } from './package.mjs';
import { advise, adviceConfig } from './advise.mjs';

const API_KEY = process.env.API_KEY ?? '';
const PORT = Number(process.env.PORT) || 8080;
const KEY_LABEL = 'local-gmap-worker-v1';
const SCAN = 'gmap.scan';
const FETCH = 'web.fetch';
const AUDIT = 'site.audit';
const LOOKUP = 'site.lookup';
const SHOT = 'web.shot';
const CHAT = 'chat.ask';
const JOB_TYPES = [SCAN, FETCH, AUDIT, LOOKUP, SHOT, CHAT];

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 1_800_000;
/** Lease past the job's own deadline: the worker keeps 60 s back to post, plus retries. */
const LEASE_GRACE_MS = 180_000;
/** A fetch is one page: seconds, not minutes. */
const FETCH_DEFAULT_TIMEOUT_MS = 60_000;
const FETCH_MIN_TIMEOUT_MS = 10_000;
const FETCH_MAX_TIMEOUT_MS = 300_000;
const FETCH_LEASE_GRACE_MS = 30_000;
const FETCH_FORMATS = ['markdown', 'text', 'html'];
/** A shot is one page in a browser: the same timeouts as a fetch. */
const SHOT_DEFAULT_TIMEOUT_MS = 60_000;
const SHOT_LEASE_GRACE_MS = 30_000;
const SHOT_DEVICES = ['desktop', 'mobile'];
/** Each shot result carries a JPEG; only this many finished shots are kept, so memory stays small. */
const KEEP_SHOTS = 100;
const AUDIT_DEFAULT_TIMEOUT_MS = 180_000;
const AUDIT_MIN_TIMEOUT_MS = 30_000;
const AUDIT_MAX_TIMEOUT_MS = 600_000;
const AUDIT_LEASE_GRACE_MS = 30_000;
const LOOKUP_DEFAULT_TIMEOUT_MS = 150_000;
const LOOKUP_MIN_TIMEOUT_MS = 10_000;
const LOOKUP_MAX_TIMEOUT_MS = 300_000;
const LOOKUP_LEASE_GRACE_MS = 30_000;
const CHAT_DEFAULT_TIMEOUT_MS = 180_000;
const CHAT_MIN_TIMEOUT_MS = 10_000;
const CHAT_MAX_TIMEOUT_MS = 600_000;
const CHAT_LEASE_GRACE_MS = 30_000;
// Canaries wait behind all earlier checks for their host, without a caller on the line.
const LOOKUP_CHECK_QUEUE_TIMEOUT_MS = 24 * 3_600_000;
const HANDLER_CHECK_INTERVAL_MS = Number(process.env.HANDLER_CHECK_INTERVAL_MS ?? 24 * 3_600_000);
/** Health lives in memory, so every start runs one check this soon, then one each interval. */
const HANDLER_CHECK_START_DELAY_MS = Number(process.env.HANDLER_CHECK_START_DELAY_MS ?? 60_000);
const HANDLERS_DIR = path.resolve(process.env.HANDLERS_DIR ?? path.join(import.meta.dirname, 'handlers'));
/** A pending job no worker claims within this long fails, so a caller never waits forever. */
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 1_800_000;
/** Past this a job is poison, not unlucky: it has lost three workers. */
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 25_000;
/** Longest a caller's request is held open waiting for a scan. */
const MAX_CALLER_WAIT_MS = 900_000;
const KEEP_FINISHED = 1000;
/** The API page: no secrets in it, so it is served without a key. */
const DOCS_PAGE = fs.readFileSync(path.resolve(import.meta.dirname, 'docs', 'index.html'));
const WORKER_LIVE_MS = 90_000;

export function workerKey(token = API_KEY) {
  return crypto.createHmac('sha256', token).update(KEY_LABEL).digest('hex');
}

/** Hash both sides first, so timingSafeEqual never sees mismatched lengths. */
function same(supplied, expected) {
  if (!supplied || !expected) return false;
  const digest = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(digest(supplied), digest(expected));
}

const jobs = new Map();
/** AI advice runs for finished audits, by job id. The advice itself is kept on the job. */
const advising = new Map();
/** Which models give AI advice (advise.mjs); null leaves the advice route answering 503. */
const ADVICE = adviceConfig();
/** Longest a caller is held waiting for advice; Railway's proxy drops a request at about 5 minutes. */
const ADVICE_MAX_WAIT_MS = 240_000;
const workers = new Map();
/** Workers holding a /api/jobs/next request open, oldest first. */
const waiters = [];
/** Callers holding a request open until a job finishes, by job id. */
const watchers = new Map();
const handlers = readHandlers();
const handlerHealth = new Map();
let checkRun = null;

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const newId = () => crypto.randomBytes(6).toString('hex');

function readHandlers() {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(HANDLERS_DIR, 'index.json'), 'utf8'));
    return new Map(index.handlers.map(({ source, ...entry }) => [entry.id, entry]));
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
}

function health(id) {
  return handlerHealth.get(id) ?? { state: 'unknown', last_ok: null, last_fail: null, last_reason: null, broken_reason: null, checked_at: null };
}

/**
 * `state` null is an ordinary lookup: an answer moves `unknown` to `ok`, a failure is recorded but judges nothing
 * (one slow or refused page is not a broken handler). `broken` stays until a canary passes or a redeploy.
 */
function markHealth(id, ok, reason, state, at = now()) {
  const previous = health(id);
  const next = state ?? (ok && previous.state === 'unknown' ? 'ok' : previous.state);
  handlerHealth.set(id, {
    state: next, last_ok: ok ? at : previous.last_ok,
    last_fail: ok ? previous.last_fail : at, last_reason: ok ? null : reason ?? null,
    // Why it broke stays readable while later ordinary lookups come and go.
    broken_reason: next !== 'broken' ? null : state === 'broken' ? reason ?? null : previous.broken_reason,
    checked_at: next !== previous.state || state ? at : previous.checked_at,
  });
}

/** A pdf handler's work ends at the PDF address (web.fetch reads it), so `reason: 'pdf'` is its normal answer. */
function answered(job, answer) {
  if (job.status !== 'done' || answer?.reason === 'layout_changed') return false;
  if (['found', 'not_found'].includes(answer?.status)) return true;
  return !!handlers.get(job.payload.handler)?.pdf && answer?.reason === 'pdf';
}

function lookupPayload(handler, keyword, worker) {
  const file = path.resolve(HANDLERS_DIR, handler.file);
  const relative = path.relative(HANDLERS_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('handler file is outside HANDLERS_DIR');
  const bytes = fs.readFileSync(file);
  const payload = {
    handler: handler.id, version: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12),
    host: handler.host, keyword, source: bytes.toString('utf8'),
  };
  if (worker) payload.worker = worker;
  return payload;
}

function runnable(handler) { return handler.tier === 1 || handler.tier === 2; }

function updateLookupHealth(job) {
  const answer = job.result?.result;
  const ok = answered(job, answer);
  // Only layout_changed or a failed canary marks a handler broken; other failures are recorded, not judged.
  const broke = job.status === 'done' && answer?.reason === 'layout_changed';
  const canary = job.check && job.check.run === checkRun?.id;
  // A canary is judged by its verdict below: an answer with the wrong status or no records is not a last_ok.
  if (!canary || broke) {
    markHealth(job.payload.handler, ok, job.error || answer?.reason || (ok ? null : 'invalid handler result'),
      broke ? 'broken' : null, job.finishedAt);
  }
  if (!canary) return;
  const verdict = checkRun.handlers.find((h) => h.handler === job.payload.handler);
  const side = job.check.side;
  const pdf = ok && answer.reason === 'pdf';
  const passed = ok && (pdf || (answer.status === side && (side !== 'found' || (Array.isArray(answer.records) && answer.records.length > 0))));
  verdict[side] = {
    job: job.id, state: passed ? 'ok' : 'broken',
    reason: passed ? null : job.error || answer?.reason || `expected ${side}${side === 'found' ? ' with at least one record' : ''}; got ${answer?.status ?? 'no status'}`,
  };
  const failed = ['found', 'not_found'].filter((s) => verdict[s].state === 'broken');
  const pending = ['found', 'not_found'].some((s) => verdict[s].state === 'pending');
  verdict.state = pending ? 'pending' : failed.length ? 'broken' : 'ok';
  verdict.reason = failed.map((s) => `${s}: ${verdict[s].reason}`).join('; ') || null;
  // A passing half cannot erase the other half's failure.
  if (failed.length || !pending) markHealth(verdict.handler, !failed.length, verdict.reason, failed.length ? 'broken' : 'ok', job.finishedAt);
  summarizeCheck();
}

function summarizeCheck() {
  checkRun.counts = { ok: 0, broken: 0, pending: 0 };
  for (const verdict of checkRun.handlers) checkRun.counts[verdict.state]++;
  if (!checkRun.counts.pending) checkRun.finished = now();
}

function startCheck(selected) {
  checkRun = { id: newId(), started: now(), finished: null, counts: {}, handlers: [] };
  for (const handler of selected) {
    const verdict = { handler: handler.id, state: 'pending', reason: null };
    checkRun.handlers.push(verdict);
    for (const side of ['found', 'not_found']) {
      try {
        const keyword = str(handler.canary?.[side]).trim();
        if (!keyword || keyword.length > 200) throw new Error('missing or invalid canary keyword');
        const job = add(lookupPayload(handler, keyword), LOOKUP_DEFAULT_TIMEOUT_MS, newId(), LOOKUP);
        job.check = { run: checkRun.id, side };
        verdict[side] = { job: job.id, state: 'pending', reason: null };
        wake(job);
      } catch (err) {
        verdict[side] = { job: null, state: 'broken', reason: err.message };
      }
    }
    const failed = ['found', 'not_found'].filter((s) => verdict[s].state === 'broken');
    if (failed.length) {
      verdict.reason = failed.map((s) => `${s}: ${verdict[s].reason}`).join('; ');
      if (!['found', 'not_found'].some((s) => verdict[s].state === 'pending')) verdict.state = 'broken';
      markHealth(handler.id, false, verdict.reason, 'broken');
    }
  }
  summarizeCheck();
  return checkRun;
}

function scheduledCheck() {
  if (!checkRun || checkRun.finished) startCheck([...handlers.values()].filter(runnable));
}

if (HANDLER_CHECK_INTERVAL_MS > 0 && !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
  setTimeout(scheduledCheck, Math.max(0, HANDLER_CHECK_START_DELAY_MS)).unref();
  setInterval(scheduledCheck, HANDLER_CHECK_INTERVAL_MS).unref();
}

function touch(name, ip) {
  const w = workers.get(name) ?? { name, firstSeen: now(), lastSeen: null, ip: null, coolUntil: 0, coolReason: null, done: 0, failed: 0 };
  w.lastSeen = now();
  if (ip) w.ip = ip;
  workers.set(name, w);
  return w;
}

/** Starts AI advice for a finished audit once; a failed run is started again on the next ask. */
function startAdvice(job) {
  if (advising.has(job.id) || job.advice?.status === 'done') return;
  job.advice = { status: 'running', startedAt: now(), finishedAt: null, result: null, error: null };
  const run = advise(job.result, ADVICE)
    .then((result) => { job.advice = { ...job.advice, status: 'done', finishedAt: now(), result }; },
      (e) => { job.advice = { ...job.advice, status: 'failed', finishedAt: now(), error: String(e?.message ?? e) }; })
    .finally(() => advising.delete(job.id));
  advising.set(job.id, run);
}

function view(job) {
  return { ...job, leaseUntil: job.leaseUntil ? new Date(job.leaseUntil).toISOString() : null };
}

function settle(job) {
  const list = watchers.get(job.id);
  if (!list) return;
  watchers.delete(job.id);
  for (const fn of list) fn(job);
}

function finishJob(job, ok, result, error) {
  if (job.type === LOOKUP && ok) {
    result = { ...result, handler: result?.handler ?? job.payload.handler, version: result?.version ?? job.payload.version,
      worker: result?.worker ?? job.worker, tookMs: result?.tookMs ?? Math.max(0, Date.now() - Date.parse(job.startedAt ?? job.createdAt)) };
  }
  job.status = ok ? 'done' : 'failed';
  job.result = ok ? result : null;
  job.error = ok ? null : (error || 'failed');
  job.finishedAt = now();
  job.leaseUntil = null;
  if (job.type === LOOKUP) updateLookupHealth(job);
  settle(job);
  evict();
  if (job.type === LOOKUP) wakeHost(job.payload.host);
}

function evict() {
  const finished = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'failed');
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id);
  const shots = finished.filter((j) => j.type === SHOT && jobs.has(j.id));
  for (const j of shots.slice(0, Math.max(0, shots.length - KEEP_SHOTS))) jobs.delete(j.id);
}

function claimable(job, worker, types) {
  return job.status === 'pending' && types.includes(job.type) && (!job.payload.worker || job.payload.worker === worker)
    && (job.type !== LOOKUP || (Date.now() - Date.parse(job.createdAt) <= queueTimeout(job)
      && ![...jobs.values()].some((j) => j.type === LOOKUP && j.status === 'running' && j.payload.host === job.payload.host)));
}

function lease(job, worker) {
  job.status = 'running';
  job.worker = worker;
  job.attempts++;
  job.startedAt = now();
  job.leaseUntil = Date.now() + job.timeoutMs + (job.type === FETCH ? FETCH_LEASE_GRACE_MS : job.type === SHOT ? SHOT_LEASE_GRACE_MS : job.type === AUDIT ? AUDIT_LEASE_GRACE_MS : job.type === LOOKUP ? LOOKUP_LEASE_GRACE_MS : LEASE_GRACE_MS);
  return job;
}

/** Hand a new job straight to a worker already waiting for one. */
function wake(job) {
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    if (!claimable(job, w.worker, w.types)) continue;
    waiters.splice(i, 1);
    w.resolve(lease(job, w.worker));
    return;
  }
}

/** The host is free again: offer its queued lookups, callers' before the canary run's. */
function wakeHost(host) {
  const queued = [...jobs.values()].filter((j) => j.type === LOOKUP && j.status === 'pending' && j.payload.host === host);
  for (const job of [...queued.filter((j) => !j.check), ...queued.filter((j) => j.check)]) wake(job);
}

/** Fetch, audit and lookup callers usually hold the line; canaries can wait their turn. */
function queueTimeout(job) {
  if (job.type === LOOKUP) return job.check ? LOOKUP_CHECK_QUEUE_TIMEOUT_MS : job.timeoutMs;
  return job.type === FETCH || job.type === SHOT || job.type === AUDIT ? job.timeoutMs : QUEUE_TIMEOUT_MS;
}

/** Expired leases go back to the queue; jobs nobody takes or that keep dying fail. */
function sweep() {
  const t = Date.now();
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.leaseUntil && job.leaseUntil < t) {
      if (job.attempts >= MAX_ATTEMPTS) { finishJob(job, false, null, `lost ${job.attempts} workers; last was ${job.worker}`); continue; }
      job.status = 'pending'; job.worker = null; job.leaseUntil = null;
      if (job.type === LOOKUP) wakeHost(job.payload.host); else wake(job);
    } else if (job.status === 'pending' && t - Date.parse(job.createdAt) > queueTimeout(job)) {
      const within = job.type === FETCH || job.type === SHOT || job.type === AUDIT || job.type === LOOKUP ? `${Math.round(queueTimeout(job) / 1000)} s` : `${Math.round(QUEUE_TIMEOUT_MS / 60000)} min`;
      finishJob(job, false, null, job.payload.worker
        ? `worker ${job.payload.worker} did not claim it within ${within}`
        : `no worker claimed it within ${within}`);
    }
  }
}
setInterval(sweep, 5_000).unref();

function readScan(body) {
  const keyword = str(body.keyword).trim();
  const place = str(body.place).trim();
  const searchMode = body.searchMode === 'location_only' ? 'location_only' : undefined;
  if (!keyword && !place) return { error: 'keyword or place is required' };
  if (keyword.length > 200 || place.length > 200) return { error: 'keyword and place are at most 200 characters' };
  const max = body.max == null ? DEFAULT_MAX : Number(body.max);
  if (!Number.isInteger(max) || max < 1 || max > MAX_LIMIT) return { error: `max is a whole number from 1 to ${MAX_LIMIT}` };
  const timeoutMs = body.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return { error: `timeoutMs is from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}` };
  }
  const payload = { keyword, place, max };
  if (searchMode) payload.searchMode = searchMode;
  if (str(body.worker).trim()) payload.worker = str(body.worker).trim();
  return { payload, timeoutMs };
}

function readFetch(body) {
  const raw = str(body.url).trim();
  if (!raw) return { error: 'url is required' };
  if (raw.length > 2048) return { error: 'url is at most 2048 characters' };
  let url;
  try { url = new URL(raw); } catch { return { error: 'url is not a URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'url must be http or https' };
  const format = body.format == null ? 'markdown' : str(body.format);
  if (!FETCH_FORMATS.includes(format)) return { error: `format is ${FETCH_FORMATS.join(', ')}` };
  const timeoutMs = body.timeoutMs == null ? FETCH_DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < FETCH_MIN_TIMEOUT_MS || timeoutMs > FETCH_MAX_TIMEOUT_MS) {
    return { error: `timeoutMs is from ${FETCH_MIN_TIMEOUT_MS} to ${FETCH_MAX_TIMEOUT_MS}` };
  }
  for (const flag of ['keepErrors', 'headers']) {
    if (body[flag] != null && typeof body[flag] !== 'boolean') return { error: `${flag} is a boolean` };
  }
  // The worker refuses private and local addresses itself: only it sees what the name resolves to.
  const payload = { url: url.href, format, mainContent: body.mainContent !== false };
  // Opt-in, and only set when asked: a fetch without them is the same job it always was.
  if (body.keepErrors === true) payload.keepErrors = true;
  if (body.headers === true) payload.headers = true;
  if (str(body.worker).trim()) payload.worker = str(body.worker).trim();
  return { payload, timeoutMs };
}

function readShot(body) {
  const raw = str(body.url).trim();
  if (!raw) return { error: 'url is required' };
  if (raw.length > 2048) return { error: 'url is at most 2048 characters' };
  let url;
  try { url = new URL(raw); } catch { return { error: 'url is not a URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'url must be http or https' };
  const device = body.device == null ? 'desktop' : str(body.device);
  if (!SHOT_DEVICES.includes(device)) return { error: `device is ${SHOT_DEVICES.join(' or ')}` };
  if (body.find != null && typeof body.find !== 'string') return { error: 'find is a string' };
  const find = str(body.find).trim();
  if (find.length > 500) return { error: 'find is at most 500 characters' };
  const waitMs = body.waitMs == null ? 1500 : Number(body.waitMs);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) return { error: 'waitMs is a whole number from 0 to 30000' };
  const quality = body.quality == null ? 72 : Number(body.quality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) return { error: 'quality is a whole number from 1 to 100' };
  const timeoutMs = body.timeoutMs == null ? SHOT_DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < FETCH_MIN_TIMEOUT_MS || timeoutMs > FETCH_MAX_TIMEOUT_MS) {
    return { error: `timeoutMs is from ${FETCH_MIN_TIMEOUT_MS} to ${FETCH_MAX_TIMEOUT_MS}` };
  }
  // As with a fetch, the worker refuses private and local addresses itself.
  const payload = { url: url.href, device, waitMs, quality };
  if (find) payload.find = find;
  if (str(body.worker).trim()) payload.worker = str(body.worker).trim();
  return { payload, timeoutMs };
}

function readAudit(body) {
  const raw = str(body.url).trim();
  if (!raw) return { error: 'url is required' };
  if (raw.length > 2048) return { error: 'url is at most 2048 characters' };
  let url;
  try { url = new URL(raw); } catch { return { error: 'url is not a URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'url must be http or https' };
  const maxPages = body.maxPages == null ? 5 : Number(body.maxPages);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 25) return { error: 'maxPages is a whole number from 1 to 25' };
  const botTest = body.botTest == null ? true : body.botTest;
  if (typeof botTest !== 'boolean') return { error: 'botTest is a boolean' };
  const timeoutMs = body.timeoutMs == null ? AUDIT_DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < AUDIT_MIN_TIMEOUT_MS || timeoutMs > AUDIT_MAX_TIMEOUT_MS) {
    return { error: `timeoutMs is from ${AUDIT_MIN_TIMEOUT_MS} to ${AUDIT_MAX_TIMEOUT_MS}` };
  }
  const payload = { url: url.href, maxPages, botTest };
  if (str(body.worker).trim()) payload.worker = str(body.worker).trim();
  return { payload, timeoutMs };
}

function readChat(body) {
  const prompt = str(body.prompt ?? body.question ?? body.message).trim();
  if (!prompt) return { error: 'prompt is required' };
  if (prompt.length > 100_000) return { error: 'prompt is at most 100000 characters' };
  const model = body.model == null ? 'auto' : str(body.model).trim();
  const timeoutMs = body.timeoutMs == null ? CHAT_DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < CHAT_MIN_TIMEOUT_MS || timeoutMs > CHAT_MAX_TIMEOUT_MS) {
    return { error: `timeoutMs is from ${CHAT_MIN_TIMEOUT_MS} to ${CHAT_MAX_TIMEOUT_MS}` };
  }
  const payload = { prompt, model };
  if (str(body.worker).trim()) payload.worker = str(body.worker).trim();
  return { payload, timeoutMs };
}

/** Adds a job to the queue without offering it to a waiting worker. */
function add(payload, timeoutMs, id = newId(), type = SCAN) {
  const job = {
    id, type, payload, timeoutMs, status: 'pending', worker: null, attempts: 0,
    createdAt: now(), startedAt: null, finishedAt: null, leaseUntil: null, result: null, error: null,
  };
  jobs.set(id, job);
  return job;
}

function create(payload, timeoutMs, type) {
  const job = add(payload, timeoutMs, newId(), type);
  wake(job);
  return job;
}

/** Resolves with the job once it is done or failed, or as it stands after `ms`. */
function waitFor(job, ms, res) {
  if (job.status === 'done' || job.status === 'failed' || ms <= 0) return Promise.resolve(job);
  return new Promise((resolve) => {
    const finish = (j) => { clearTimeout(timer); res.off('close', onClose); resolve(j); };
    const list = watchers.get(job.id) ?? [];
    list.push(finish);
    watchers.set(job.id, list);
    const drop = () => { const l = watchers.get(job.id); if (l) { const i = l.indexOf(finish); if (i >= 0) l.splice(i, 1); } };
    const timer = setTimeout(() => { drop(); finish(job); }, ms);
    // The caller hung up: stop waiting. The job itself runs on.
    const onClose = () => { drop(); finish(job); };
    res.once('close', onClose);
  });
}

function take(worker, types, waitMs, res) {
  // A caller is usually holding the line; the canary run's lookups can wait behind it.
  const list = [...jobs.values()].filter((j) => claimable(j, worker, types));
  const ready = list.find((j) => !j.check) ?? list[0];
  if (ready) return Promise.resolve(lease(ready, worker));
  if (waitMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const entry = { worker, types, resolve: (job) => { clearTimeout(timer); res.off('close', onClose); resolve(job); } };
    waiters.push(entry);
    const drop = () => { const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1); };
    const timer = setTimeout(() => { drop(); res.off('close', onClose); resolve(null); }, waitMs);
    // A worker that hangs up mid-poll must not be handed a job it will drop.
    const onClose = () => { drop(); clearTimeout(timer); resolve(null); };
    res.once('close', onClose);
  });
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw Object.assign(new Error('body is over 20 MB'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch { throw Object.assign(new Error('body is not JSON'), { status: 400 }); }
}

/** This service's own address as the caller reached it, for the package's HUB_URL. */
function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = str(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const proto = str(req.headers['x-forwarded-proto'] ?? (host.startsWith('localhost') ? 'http' : 'https')).split(',')[0];
  return `${proto}://${host}`;
}

function callerIp(req) {
  return str(req.headers['x-forwarded-for']).split(',')[0].trim() || req.socket.remoteAddress || null;
}

function who(req) {
  const auth = str(req.headers.authorization);
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : str(req.headers['x-api-key']).trim();
  if (same(token, API_KEY)) return 'caller';
  if (same(token, workerKey())) return 'worker';
  return null;
}

function isWorkerRoute(method, p) {
  return (method === 'GET' && (p === '/api/jobs/next' || p === '/api/worker/strategy'))
    || (method === 'POST' && (p === '/api/jobs/heartbeat' || /^\/api\/jobs\/[a-f0-9]{12}\/result$/.test(p)));
}

function liveWorkers() {
  const t = Date.now();
  return [...workers.values()].map((w) => ({
    ...w,
    live: t - Date.parse(w.lastSeen) < WORKER_LIVE_MS,
    coolUntil: w.coolUntil > t ? new Date(w.coolUntil).toISOString() : null,
    coolReason: w.coolUntil > t ? w.coolReason : null,
    job: [...jobs.values()].find((j) => j.status === 'running' && j.worker === w.name)?.id ?? null,
  }));
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const method = req.method ?? 'GET';
  const q = url.searchParams;

  if (method === 'GET' && (p === '/' || p === '/health')) {
    json(res, 200, { ok: true, service: 'local-gmap-worker', workersLive: liveWorkers().filter((w) => w.live).length });
    return;
  }

  if (method === 'GET' && (p === '/docs' || p === '/docs/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': DOCS_PAGE.length, 'cache-control': 'no-cache' });
    res.end(DOCS_PAGE);
    return;
  }

  const as = who(req);
  if (!as) { json(res, 401, { error: 'send Authorization: Bearer <API_KEY>' }); return; }
  if (as === 'worker' && !isWorkerRoute(method, p)) { json(res, 403, { error: 'a worker key reaches only the worker routes' }); return; }

  // ------------------------------------------------------------- workers

  if (method === 'GET' && p === '/api/jobs/next') {
    const worker = str(q.get('worker')).trim();
    if (!worker) { json(res, 400, { error: 'worker is required' }); return; }
    const asked = str(q.get('types')).split(',').map((t) => t.trim()).filter(Boolean);
    let types = asked.length ? JOB_TYPES.filter((t) => asked.includes(t)) : [SCAN, FETCH];
    if (!types.length) { res.writeHead(204).end(); return; }
    const w = touch(worker, callerIp(req));
    w.types = types;
    const waitSec = Number(q.get('wait'));
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number.isFinite(waitSec) ? waitSec * 1000 : MAX_WAIT_MS));
    // A worker Google is resting gets no scans, but still fetches pages.
    if (w.coolUntil > Date.now()) types = types.filter((t) => t !== SCAN);
    // Nothing it may take: hold its poll so it does not spin.
    if (!types.length) {
      await new Promise((r) => setTimeout(r, waitMs));
      res.writeHead(204).end();
      return;
    }
    const job = await take(worker, types, waitMs, res);
    if (!job) { if (!res.destroyed) res.writeHead(204).end(); return; }
    if (res.destroyed) { job.status = 'pending'; job.worker = null; job.attempts--; job.leaseUntil = null; wake(job); return; }
    json(res, 200, { job: view(job) });
    return;
  }

  if (method === 'POST' && p === '/api/jobs/heartbeat') {
    const body = await readJson(req);
    const worker = str(body.worker).trim();
    if (!worker) { json(res, 400, { error: 'worker is required' }); return; }
    touch(worker, callerIp(req));
    json(res, 200, { ok: true });
    return;
  }

  const result = /^\/api\/jobs\/([a-f0-9]{12})\/result$/.exec(p);
  if (method === 'POST' && result) {
    const id = result[1];
    const body = await readJson(req);
    const worker = str(body.worker).trim();
    if (!worker) { json(res, 400, { error: 'worker is required' }); return; }
    const w = touch(worker, callerIp(req));
    const retryAfterMs = Number(body.retryAfterMs);
    // An older worker may still post a linkedin.scrape result: it never cools the Maps scans.
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && body.type !== 'linkedin.scrape') {
      w.coolUntil = Date.now() + Math.min(retryAfterMs, 6 * 3_600_000);
      w.coolReason = 'Google refused this line';
    }
    let job = jobs.get(id);
    if (!job) {
      // Lost to a restart: file it again under the same id.
      if (!body.payload || typeof body.payload !== 'object') { json(res, 404, { error: 'no such job' }); return; }
      // Not create(): a waiting worker must not be handed a job this one is about to finish.
      const type = JOB_TYPES.includes(body.type) ? body.type : SCAN;
      job = add({ ...body.payload }, type === FETCH ? FETCH_DEFAULT_TIMEOUT_MS : type === SHOT ? SHOT_DEFAULT_TIMEOUT_MS : type === AUDIT ? AUDIT_DEFAULT_TIMEOUT_MS : type === LOOKUP ? LOOKUP_DEFAULT_TIMEOUT_MS : type === CHAT ? CHAT_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, id, type);
      lease(job, worker);
    }
    if (job.status === 'done' || job.status === 'failed') { json(res, 409, { error: `job is already ${job.status}` }); return; }
    if (job.worker && job.worker !== worker) { json(res, 409, { error: `job is held by ${job.worker}` }); return; }
    // A late lookup result may arrive after its lease was put back in the queue.
    if (job.type === LOOKUP && !job.worker) job.worker = worker;
    const ok = body.ok === true;
    if (ok) w.done++; else w.failed++;
    finishJob(job, ok, body.result ?? null, str(body.error));
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && p === '/api/worker/strategy') { json(res, 200, strategy()); return; }

  // ------------------------------------------------------------- callers

  if (method === 'GET' && p === '/api/handlers') {
    const list = [...handlers.values()].filter((h) => (!q.get('country') || h.country === q.get('country'))
      && (!q.get('host') || h.host === q.get('host'))).map((h) => ({ ...h, health: health(h.id) }));
    json(res, 200, { handlers: list });
    return;
  }

  if (p === '/api/handlers/check' && method === 'GET') { json(res, 200, { run: checkRun }); return; }
  if (p === '/api/handlers/check' && method === 'POST') {
    const body = await readJson(req);
    if (checkRun && !checkRun.finished) { json(res, 409, { error: 'a handler check is already running' }); return; }
    const handler = body.handler == null ? null : handlers.get(str(body.handler));
    if (body.handler != null && !handler) { json(res, 404, { error: 'no such handler' }); return; }
    if (handler && !runnable(handler)) {
      json(res, 422, { error: 'handler is not runnable', tier: handler.tier, tier4: handler.tier4, browser_steps: handler.browser_steps }); return;
    }
    json(res, 202, { run: startCheck(handler ? [handler] : [...handlers.values()].filter(runnable)) });
    return;
  }

  if (method === 'POST' && p === '/api/lookup') {
    const body = await readJson(req);
    const handler = handlers.get(str(body.handler));
    if (!handler) { json(res, 404, { error: 'no such handler' }); return; }
    if (!runnable(handler)) {
      json(res, 422, { error: 'handler is not runnable', tier: handler.tier, tier4: handler.tier4, browser_steps: handler.browser_steps }); return;
    }
    const keyword = str(body.keyword).trim();
    if (!keyword || keyword.length > 200) { json(res, 422, { error: 'keyword must have 1 to 200 characters' }); return; }
    const timeoutMs = body.timeoutMs == null ? LOOKUP_DEFAULT_TIMEOUT_MS : Number(body.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < LOOKUP_MIN_TIMEOUT_MS || timeoutMs > LOOKUP_MAX_TIMEOUT_MS) {
      json(res, 400, { error: `timeoutMs is from ${LOOKUP_MIN_TIMEOUT_MS} to ${LOOKUP_MAX_TIMEOUT_MS}` }); return;
    }
    const job = create(lookupPayload(handler, keyword, str(body.worker).trim()), timeoutMs, LOOKUP);
    const waitSec = Number(body.wait ?? q.get('wait') ?? NaN);
    const waitMs = Number.isFinite(waitSec) ? waitSec * 1000 : timeoutMs + LOOKUP_LEASE_GRACE_MS;
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, waitMs), res);
    if (!res.destroyed) json(res, waited.status === 'done' || waited.status === 'failed' ? 200 : 202, { job: view(waited) });
    return;
  }

  if (method === 'POST' && p === '/api/scan') {
    const body = await readJson(req);
    const scan = readScan(body);
    if (scan.error) { json(res, 400, { error: scan.error }); return; }
    const job = create(scan.payload, scan.timeoutMs, SCAN);
    const waitSec = Number(body.wait ?? q.get('wait'));
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, Number.isFinite(waitSec) ? waitSec * 1000 : 0), res);
    if (res.destroyed) return;
    json(res, waited.status === 'done' || waited.status === 'failed' ? 200 : 202, { job: view(waited) });
    return;
  }

  if (method === 'POST' && p === '/api/fetch') {
    const body = await readJson(req);
    const page = readFetch(body);
    if (page.error) { json(res, 400, { error: page.error }); return; }
    const job = create(page.payload, page.timeoutMs, FETCH);
    // Answers in the same call unless the caller says otherwise, like Jina Reader; wait 0 returns the id at once.
    const waitSec = Number(body.wait ?? q.get('wait') ?? NaN);
    const waitMs = Number.isFinite(waitSec) ? waitSec * 1000 : page.timeoutMs + FETCH_LEASE_GRACE_MS;
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, waitMs), res);
    if (res.destroyed) return;
    json(res, waited.status === 'done' || waited.status === 'failed' ? 200 : 202, { job: view(waited) });
    return;
  }

  if (method === 'POST' && p === '/api/shot') {
    const body = await readJson(req);
    const shot = readShot(body);
    if (shot.error) { json(res, 400, { error: shot.error }); return; }
    const job = create(shot.payload, shot.timeoutMs, SHOT);
    // Like a fetch: answers in the same call unless the caller says otherwise; wait 0 returns the id at once.
    const waitSec = Number(body.wait ?? q.get('wait') ?? NaN);
    const waitMs = Number.isFinite(waitSec) ? waitSec * 1000 : shot.timeoutMs + SHOT_LEASE_GRACE_MS;
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, waitMs), res);
    if (res.destroyed) return;
    json(res, waited.status === 'done' || waited.status === 'failed' ? 200 : 202, { job: view(waited) });
    return;
  }

  if (method === 'POST' && p === '/api/audit') {
    const body = await readJson(req);
    const audit = readAudit(body);
    if (audit.error) { json(res, 400, { error: audit.error }); return; }
    const job = create(audit.payload, audit.timeoutMs, AUDIT);
    // Wait for the report by default; wait 0 returns the id at once.
    const waitSec = Number(body.wait ?? q.get('wait') ?? NaN);
    const waitMs = Number.isFinite(waitSec) ? waitSec * 1000 : audit.timeoutMs + AUDIT_LEASE_GRACE_MS;
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, waitMs), res);
    if (res.destroyed) return;
    json(res, waited.status === 'done' || waited.status === 'failed' ? 200 : 202, { job: view(waited) });
    return;
  }

  if (method === 'POST' && p === '/api/chat') {
    const body = await readJson(req);
    const chat = readChat(body);
    if (chat.error) { json(res, 400, { error: chat.error }); return; }
    const job = create(chat.payload, chat.timeoutMs, CHAT);
    const waitSec = Number(body.wait ?? q.get('wait') ?? NaN);
    const waitMs = Number.isFinite(waitSec) ? waitSec * 1000 : chat.timeoutMs + CHAT_LEASE_GRACE_MS;
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, waitMs), res);
    if (res.destroyed) return;
    json(res, waited.status === 'done' || waited.status === 'failed' ? 200 : 202, { job: view(waited) });
    return;
  }

  const adviceFor = /^\/api\/audit\/([a-f0-9]{12})\/advice$/.exec(p);
  if (adviceFor && (method === 'POST' || method === 'GET')) {
    const body = method === 'POST' ? await readJson(req) : {};
    const job = jobs.get(adviceFor[1]);
    if (!job || job.type !== AUDIT) { json(res, 404, { error: 'no such audit' }); return; }
    if (method === 'POST') {
      if (!ADVICE) { json(res, 503, { error: 'AI advice is not set up on this service: set AGY_URL and AGY_TOKEN, or ADVICE_BACKUP_URL and ADVICE_BACKUP_KEY' }); return; }
      if (job.status !== 'done') { json(res, 409, { error: job.status === 'failed' ? 'the audit failed, so there is nothing to advise on' : 'the audit is not finished yet' }); return; }
      startAdvice(job);
    }
    // POST waits 20 s by default and GET not at all; wait (seconds) changes it, up to 240.
    const waitSec = Number(body.wait ?? q.get('wait') ?? (method === 'POST' ? 20 : 0));
    const waitMs = Math.max(0, Math.min(ADVICE_MAX_WAIT_MS, Number.isFinite(waitSec) ? waitSec * 1000 : 0));
    const running = advising.get(job.id);
    if (running && waitMs > 0) {
      let timer;
      await Promise.race([running, new Promise((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    }
    if (res.destroyed) return;
    const advice = job.advice ?? null;
    json(res, advice?.status === 'running' ? 202 : 200, { jobId: job.id, advice });
    return;
  }

  const jobId = /^\/api\/(?:jobs|scan|fetch|shot|audit|lookup|chat)\/([a-f0-9]{12})$/.exec(p);
  if (jobId && method === 'GET') {
    const job = jobs.get(jobId[1]);
    if (!job) { json(res, 404, { error: 'no such job' }); return; }
    const waitSec = Number(q.get('wait'));
    const waited = await waitFor(job, Math.min(MAX_CALLER_WAIT_MS, Number.isFinite(waitSec) ? waitSec * 1000 : 0), res);
    if (res.destroyed) return;
    json(res, 200, { job: view(waited) });
    return;
  }
  if (jobId && method === 'DELETE') {
    const job = jobs.get(jobId[1]);
    if (!job) { json(res, 404, { error: 'no such job' }); return; }
    if (job.status === 'done' || job.status === 'failed') { json(res, 409, { error: `job is already ${job.status}` }); return; }
    finishJob(job, false, null, 'cancelled by the caller');
    json(res, 200, { job: view(job) });
    return;
  }

  if (method === 'GET' && p === '/api/scans') {
    const status = str(q.get('status'));
    const type = str(q.get('type'));
    const list = [...jobs.values()].filter((j) => (!status || j.status === status) && (!type || j.type === type)).reverse().slice(0, 200)
      .map(({ result, ...j }) => ({ ...view(j), found: result?.found ?? null, ...(j.type === SHOT ? { blocked: result?.blocked ?? null } : {}) }));
    json(res, 200, { jobs: list });
    return;
  }

  if (method === 'GET' && p === '/api/workers') { json(res, 200, { workers: liveWorkers() }); return; }

  if (method === 'GET' && p === '/api/worker/package') {
    const body = packageZip(publicUrl(req), workerKey());
    res.writeHead(200, {
      'content-type': 'application/zip', 'content-length': body.length, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${PACKAGE_NAME}"`,
    });
    res.end(body);
    return;
  }

  json(res, 404, { error: 'not found' });
}

export function start(port = PORT) {
  if (API_KEY.length < 16) throw new Error('set API_KEY (16 characters or more)');
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
      else res.destroy();
    });
  });
  // Long polls and caller waits outlive Node's default request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then((s) => console.log(`local-gmap-worker listening on :${s.address().port}`));
}
