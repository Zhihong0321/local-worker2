#!/usr/bin/env node
// Builds the site.lookup handler library in `handlers/` from the probe data.
//
// The probe's verdict for one want lives next to its handler:
//   <probe>/<TASK_ID>/<want>.json           accepted verdict: tier, method, pdf, canary, verified, tier4, browser_steps
//   <probe>/<TASK_ID>/<want>.handler.mjs    the handler (tiers 1 and 2 only; a file may be left behind by a want that
//                                           was later rejected, so the verdict decides, never the file)
// and the tasks and their wants:
//   <tasks.json>   { tasks: [ { id, country_code, host, wants: [ { want, source_name, source_url, question } ] } ] }
//
// Output (everything inside `handlers/`, nothing else is touched):
//   handlers/<CC>/<TASK_ID>.<want>.mjs   the handler, byte for byte
//   handlers/index.json                  { handlers: [ entry, ... ] }, sorted by id
//
// Entry fields, in this order: id, country, host, task, want, question, source_name, source_url, tier, method, pdf,
// canary, file, tier4, browser_steps, verified_at, version. `file` is relative to handlers/ and null for tier 3/4;
// `version` is the first 12 hex of sha256 of the handler file's bytes, null for tier 3/4.
//
// Deterministic: the same input gives byte-identical output (stable order, LF endings, 2-space JSON, trailing
// newline). A second run reports no changes.
//
// Usage:
//   node scripts/import-handlers.mjs [--probe DIR] [--tasks FILE] [--out DIR] [--check]
//   --probe  the probe's per-task folders    (env PROBE_DIR)
//   --tasks  the probe's tasks.json          (env TASKS_FILE)
//   --out    the library to write            (env HANDLERS_OUT, default <repo>/handlers)
//   --check  write nothing; exit 1 if handlers/ is not already what this run would produce
// COMPANY_DIVER_DIR moves the default probe/tasks locations off this PC's default.
// Only node: built-ins are used. Nothing under the probe folder is written.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Where the probe data lives on the machine that made it. Both paths can be overridden (see --probe / --tasks).
const COMPANY_DIVER_DIR = process.env.COMPANY_DIVER_DIR ?? 'G:/company-diver';
const DEFAULT_PROBE_DIR = path.join(COMPANY_DIVER_DIR, 'agy-lab/research-tracker/data/probe');
const DEFAULT_TASKS_FILE = path.join(COMPANY_DIVER_DIR, 'agy-lab/research-tracker/probe/tasks.json');

const TIERS = new Set([1, 2, 3, 4]);

// --- command line ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { probe: null, tasks: null, out: null, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--probe') opts.probe = value();
    else if (arg === '--tasks') opts.tasks = value();
    else if (arg === '--out') opts.out = value();
    else if (arg.startsWith('--probe=')) opts.probe = arg.slice(8);
    else if (arg.startsWith('--tasks=')) opts.tasks = arg.slice(8);
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6);
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const USAGE = `Usage: node scripts/import-handlers.mjs [--probe DIR] [--tasks FILE] [--out DIR] [--check]

  --probe DIR   the probe's per-task folders (env PROBE_DIR; default ${DEFAULT_PROBE_DIR})
  --tasks FILE  the probe's tasks.json (env TASKS_FILE; default ${DEFAULT_TASKS_FILE})
  --out DIR     the library to write (env HANDLERS_OUT; default ${path.join(REPO, 'handlers')})
  --check       write nothing; exit 1 if handlers/ is not what this run would produce
`;

// --- small helpers --------------------------------------------------------------------------------------------

function readJson(file) {
  // A BOM in a JSON file makes JSON.parse throw; the probe writes plain UTF-8, but be forgiving about it.
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function sha256Short(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

// Plain code-unit comparison, so the order is the same on every OS and locale (what Array#sort does by default).
function byId(a, b) {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.lstatSync(abs);
    if (stat.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

// What one handler's own `meta` says, read without executing the file. Covers both `{ task: 'x' }` and
// `{ "task": "x" }`. Only used as a cross-check against the verdict; a null means "could not read it".
function metaString(source, key) {
  const quote = '["\'`]';
  const re = new RegExp('(?:^|[{,\\s])' + quote + '?' + key + quote + '?\\s*:\\s*' + quote + "([^\"'`]*)" + quote);
  const match = re.exec(source);
  return match ? match[1] : null;
}

// --- input ----------------------------------------------------------------------------------------------------

function findTasksFile(explicit, probeDir) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  else {
    if (process.env.TASKS_FILE) candidates.push(process.env.TASKS_FILE);
    candidates.push(DEFAULT_TASKS_FILE);
    // The plan and the real layout differ by one folder; accept the file next to the probe data too.
    candidates.push(path.join(probeDir, 'tasks.json'));
    candidates.push(path.join(probeDir, '..', 'probe', 'tasks.json'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
  throw new Error(`no tasks.json found. Tried:\n  ${candidates.map((c) => path.resolve(c)).join('\n  ')}\n`
    + 'Pass --tasks <file> or set TASKS_FILE.');
}

function loadTasks(file) {
  const data = readJson(file);
  const tasks = Array.isArray(data) ? data : data.tasks;
  if (!Array.isArray(tasks)) throw new Error(`${file}: expected { tasks: [ ... ] }`);
  const seen = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id) throw new Error(`${file}: a task has no id`);
    if (seen.has(task.id)) throw new Error(`${file}: task ${task.id} appears twice`);
    seen.add(task.id);
    if (typeof task.country_code !== 'string' || !task.country_code) {
      throw new Error(`${file}: task ${task.id} has no country_code`);
    }
    if (typeof task.host !== 'string' || !task.host) throw new Error(`${file}: task ${task.id} has no host`);
    if (!Array.isArray(task.wants) || task.wants.length === 0) {
      throw new Error(`${file}: task ${task.id} has no wants`);
    }
  }
  return tasks;
}

// --- one want -> one index entry (plus the handler bytes, when there are any) ---------------------------------

function buildEntry(task, want, verdictFile, probeDir, notes) {
  const id = `${task.id}/${want.want}`;
  const verdict = readJson(verdictFile);
  const tier = verdict.tier;
  const note = (message) => notes.push({ id, message });

  if (!TIERS.has(tier)) throw new Error(`${id}: verdict has no usable tier (${JSON.stringify(tier)})`);
  if (verdict.want !== undefined && verdict.want !== want.want) {
    note(`verdict says want ${JSON.stringify(verdict.want)}, tasks.json says ${JSON.stringify(want.want)}; used the task's`);
  }

  let file = null;
  let version = null;
  let bytes = null;
  let method = null;
  let pdf = false;
  let canary = null;
  let tier4 = null;
  let browserSteps = null;
  let verifiedAt = null;

  if (tier === 1 || tier === 2) {
    const handlerFile = path.join(probeDir, task.id, `${want.want}.handler.mjs`);
    if (!fs.existsSync(handlerFile)) {
      throw new Error(`${id}: tier ${tier} but ${handlerFile} does not exist`);
    }
    bytes = fs.readFileSync(handlerFile);
    file = `${task.country_code}/${task.id}.${want.want}.mjs`;
    version = sha256Short(bytes);

    // The verdict carries the method and the two canary names; the handler repeats them in its meta.
    if (typeof verdict.method === 'string' && verdict.method) method = verdict.method;
    else note('verdict has no method; index method is null');
    if (typeof verdict.pdf === 'boolean') pdf = verdict.pdf;
    else note(`verdict has no boolean pdf (${JSON.stringify(verdict.pdf)}); index pdf is false`);

    if (verdict.canary && typeof verdict.canary === 'object') {
      const found = verdict.canary.found ?? null;
      const notFound = verdict.canary.not_found ?? null;
      if (found === null || notFound === null) note('verdict canary is missing found and/or not_found; null kept');
      canary = { found, not_found: notFound };
    } else {
      note('verdict has no canary; index canary is null');
    }

    if (verdict.verified && typeof verdict.verified.at === 'string') verifiedAt = verdict.verified.at;
    else note('verdict has no verified.at; index verified_at is null');
    if (verdict.verified && typeof verdict.verified.note === 'string' && verdict.verified.note) {
      note(`probe note on this handler: ${verdict.verified.note}`);
    }

    // Cross-check the handler's own meta against the verdict. Warn only: the verdict is the record of truth.
    const source = bytes.toString('utf8');
    const metaTask = metaString(source, 'task');
    const metaWant = metaString(source, 'want');
    const metaMethod = metaString(source, 'method');
    if (metaTask !== null && metaTask !== task.id) note(`handler meta.task is ${JSON.stringify(metaTask)}, not ${JSON.stringify(task.id)}`);
    if (metaWant !== null && metaWant !== want.want) note(`handler meta.want is ${JSON.stringify(metaWant)}, not ${JSON.stringify(want.want)}`);
    if (metaMethod !== null && method !== null && metaMethod !== method) {
      note(`handler meta.method is ${JSON.stringify(metaMethod)}, verdict method is ${JSON.stringify(method)}; index uses the verdict`);
    }
    if (!/export\s+default\s+/.test(source)) note('handler has no `export default`');
    if (!/export\s+const\s+meta\s*=/.test(source)) note('handler has no `export const meta =`');
  } else if (tier === 3) {
    if (typeof verdict.browser_steps === 'string' && verdict.browser_steps.trim()) browserSteps = verdict.browser_steps;
    else note('tier 3 but verdict has no browser_steps');
  } else {
    if (verdict.tier4 && typeof verdict.tier4 === 'object') {
      tier4 = { reason: verdict.tier4.reason ?? null, evidence: verdict.tier4.evidence ?? null };
      if (tier4.reason === null) note('tier 4 but verdict.tier4 has no reason');
      if (tier4.evidence === null) note('tier 4 but verdict.tier4 has no evidence');
    } else {
      note('tier 4 but verdict has no tier4 { reason, evidence }');
    }
    // A handler file may still sit on disk for a want that was later rejected; the verdict wins and it is not used.
    if (fs.existsSync(path.join(probeDir, task.id, `${want.want}.handler.mjs`))) {
      note(`tier ${tier} but a handler file exists; the verdict wins, so it is not published`);
    }
  }

  if (typeof want.question !== 'string' || !want.question) note('want has no question');
  if (typeof want.source_name !== 'string' || !want.source_name) note('want has no source_name');
  if (typeof want.source_url !== 'string' || !want.source_url) note('want has no source_url');

  // Key order here is the contract's field order; JSON.stringify keeps it.
  const entry = {
    id,
    country: task.country_code,
    host: task.host,
    task: task.id,
    want: want.want,
    question: want.question ?? null,
    source_name: want.source_name ?? null,
    source_url: want.source_url ?? null,
    tier,
    method,
    pdf,
    canary,
    file,
    tier4,
    browser_steps: browserSteps,
    verified_at: verifiedAt,
    version,
  };
  return { entry, bytes };
}

// --- output ---------------------------------------------------------------------------------------------------

function importLibrary({ probeDir, tasksFile, outDir, check }) {
  const tasks = loadTasks(tasksFile);
  const notes = [];
  const entries = [];
  const handlers = new Map(); // relative path under handlers/ -> bytes
  const ids = new Set();

  for (const task of tasks) {
    for (const want of task.wants) {
      if (typeof want.want !== 'string' || !want.want) throw new Error(`task ${task.id}: a want has no name`);
      const verdictFile = path.join(probeDir, task.id, `${want.want}.json`);
      if (!fs.existsSync(verdictFile)) throw new Error(`${task.id}/${want.want}: no verdict at ${verdictFile}`);
      const { entry, bytes } = buildEntry(task, want, verdictFile, probeDir, notes);
      if (ids.has(entry.id)) throw new Error(`duplicate id ${entry.id}`);
      ids.add(entry.id);
      entries.push(entry);
      if (bytes !== null) handlers.set(entry.file, bytes);
    }
  }

  entries.sort(byId);

  const indexText = `${JSON.stringify({ handlers: entries }, null, 2)}\n`;
  const indexBytes = Buffer.from(indexText, 'utf8');

  const expected = new Map(handlers);
  expected.set('index.json', indexBytes);

  // A handler file on disk that no want claims is left over from a want that was later rejected or renamed.
  const removed = [];
  if (fs.existsSync(outDir)) {
    for (const rel of listFiles(outDir).sort()) {
      if (expected.has(rel)) continue;
      if (rel.endsWith('.mjs')) {
        removed.push(rel);
        if (!check) fs.rmSync(path.join(outDir, rel));
      } else if (!check) {
        notes.push({ id: '-', message: `left ${rel} in handlers/ alone: not a handler file and not index.json` });
      }
    }
  }

  // Write only what differs, so a second run touches nothing and reports no changes.
  const changed = [];
  if (!check) {
    for (const [rel, bytes] of [...expected].sort((a, b) => byId({ id: a[0] }, { id: b[0] }))) {
      const abs = path.join(outDir, rel);
      const old = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      if (old !== null && old.equals(bytes)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      changed.push(rel);
    }
    // Drop folders that only held stale files.
    const prune = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (fs.lstatSync(abs).isDirectory()) {
          prune(abs);
          if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        }
      }
    };
    prune(outDir);
  } else {
    for (const [rel, bytes] of expected) {
      const abs = path.join(outDir, rel);
      const old = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      if (old === null || !old.equals(bytes)) changed.push(rel);
    }
  }

  return { entries, handlerCount: handlers.size, notes, removed, changed, check };
}

// --- report ---------------------------------------------------------------------------------------------------

function report(result, paths, elapsedMs) {
  const { entries, handlerCount, notes, removed, changed, check } = result;
  const byTier = new Map();
  for (const entry of entries) {
    const key = `${entry.country}\u0000${entry.tier}`;
    byTier.set(key, (byTier.get(key) ?? 0) + 1);
  }
  const countries = [...new Set(entries.map((e) => e.country))].sort();
  const tierCount = (tier) => entries.filter((e) => e.tier === tier).length;

  console.log(`probe: ${paths.probeDir}`);
  console.log(`tasks: ${paths.tasksFile}`);
  console.log(`out:   ${paths.outDir}${check ? '  (--check: nothing written)' : ''}`);
  console.log('');
  console.log(`entries: ${entries.length}`);
  console.log(`handler files: ${handlerCount}`);
  console.log('');
  console.log('country  tier1  tier2  tier3  tier4  total');
  for (const country of countries) {
    const at = (tier) => String(byTier.get(`${country}\u0000${tier}`) ?? 0);
    const total = entries.filter((e) => e.country === country).length;
    console.log(`${country.padEnd(7)}  ${at(1).padStart(5)}  ${at(2).padStart(5)}  ${at(3).padStart(5)}  ${at(4).padStart(5)}  ${String(total).padStart(5)}`);
  }
  const sum = (tier) => String(tierCount(tier));
  console.log(`${'all'.padEnd(7)}  ${sum(1).padStart(5)}  ${sum(2).padStart(5)}  ${sum(3).padStart(5)}  ${sum(4).padStart(5)}  ${String(entries.length).padStart(5)}`);
  console.log('');

  if (removed.length) {
    console.log(`stale handler files ${check ? 'that would be removed' : 'removed'}: ${removed.length}`);
    for (const rel of removed) console.log(`  ${rel}`);
  }
  if (notes.length) {
    console.log(`notes (${notes.length}):`);
    for (const note of notes) console.log(`  ${note.id}: ${note.message}`);
  }
  if (check) {
    console.log(changed.length === 0
      ? 'check: handlers/ is up to date'
      : `check: ${changed.length} file(s) differ from what this run would write:\n  ${changed.join('\n  ')}`);
  } else {
    console.log(changed.length === 0
      ? 'no changes: handlers/ was already up to date'
      : `wrote ${changed.length} file(s): ${changed.join(', ')}`);
  }
  console.log(`took ${elapsedMs} ms`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const started = Date.now();
  try {
    const probeDir = path.resolve(opts.probe ?? process.env.PROBE_DIR ?? DEFAULT_PROBE_DIR);
    if (!fs.existsSync(probeDir) || !fs.statSync(probeDir).isDirectory()) {
      throw new Error(`probe folder not found: ${probeDir}\nPass --probe <dir> or set PROBE_DIR.`);
    }
    const tasksFile = findTasksFile(opts.tasks ?? null, probeDir);
    const outDir = path.resolve(opts.out ?? process.env.HANDLERS_OUT ?? path.join(REPO, 'handlers'));

    const result = importLibrary({ probeDir, tasksFile, outDir, check: opts.check });
    report(result, { probeDir, tasksFile, outDir }, Date.now() - started);
    if (opts.check && result.changed.length > 0) process.exit(1);
  } catch (error) {
    console.error(`import-handlers: ${error.message}`);
    process.exit(1);
  }
}

main();
