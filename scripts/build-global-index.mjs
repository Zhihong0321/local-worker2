#!/usr/bin/env node
// Builds handlers/ALL/index.json, the index of the GLOBAL handlers: handlers that take a company's website domain
// instead of a company name and apply to every report, whatever the country.
//
// These are written by hand, so each file's own `meta` is the source of truth (task, want, tier, method, question,
// why_it_matters, source_name, source_url, host, canary). The country handlers come from the probe through
// scripts/import-handlers.mjs, which leaves handlers/ALL/ alone; the server reads both indexes.
//
// Entry fields follow the country entries (id, country, host, task, want, question, source_name, source_url, tier,
// method, pdf, canary, file, tier4, browser_steps, verified_at, version) plus `input: "domain"`, `scope: "global"`
// and `why_it_matters`. `version` is the first 12 hex of sha256 of the file's bytes, as the server computes it.
// `verified_at` stays null until a canary run has passed.
//
// Usage: node scripts/build-global-index.mjs [--check]
//   --check  write nothing; exit 1 if handlers/ALL/index.json is not what this run would produce

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(REPO, 'handlers', 'ALL');
const INDEX = path.join(DIR, 'index.json');
const check = process.argv.includes('--check');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort();
const entries = [];
for (const name of files) {
  const abs = path.join(DIR, name);
  const bytes = fs.readFileSync(abs);
  const { meta } = await import(pathToFileURL(abs).href);
  if (!meta?.task || !meta?.want || !meta?.question || !meta?.canary?.found || !meta?.canary?.not_found) {
    throw new Error(`${name}: meta needs task, want, question and a canary with found and not_found`);
  }
  const previous = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')).handlers.find((h) => h.id === `${meta.task}/${meta.want}`) : null;
  entries.push({
    id: `${meta.task}/${meta.want}`,
    country: 'ALL',
    host: meta.host ?? meta.task,
    task: meta.task,
    want: meta.want,
    question: meta.question,
    why_it_matters: meta.why_it_matters ?? '',
    source_name: meta.source_name ?? meta.task,
    source_url: meta.source_url ?? '',
    tier: meta.tier ?? 1,
    method: meta.method ?? 'json_api',
    pdf: false,
    input: meta.input ?? 'domain',
    scope: 'global',
    canary: meta.canary,
    file: `ALL/${name}`,
    tier4: null,
    browser_steps: null,
    verified_at: previous?.verified_at ?? null,
    version: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
  });
}
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const text = `${JSON.stringify({ handlers: entries }, null, 2)}\n`;
const old = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : null;
if (check) {
  if (old !== text) { console.error('handlers/ALL/index.json is out of date: run node scripts/build-global-index.mjs'); process.exit(1); }
  console.log(`handlers/ALL/index.json is current (${entries.length} handlers)`);
} else if (old === text) {
  console.log(`no changes (${entries.length} global handlers)`);
} else {
  fs.writeFileSync(INDEX, text);
  console.log(`wrote handlers/ALL/index.json (${entries.length} global handlers)`);
}
