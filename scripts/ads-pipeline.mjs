// The ads research pipeline: raw result -> analysis -> report.
//   node scripts/ads-pipeline.mjs <result.json> [out.html]
// Needs an OpenAI-compatible chat API in the environment: ADS_LLM_URL, ADS_LLM_KEY,
// ADS_LLM_MODEL (and optionally ADS_LLM_BACKUP_*). Without one the report is still
// written, with the counts it can make and a note that the analysis is missing.
//   1. analyze.mjs labels every ad with the LLM, counts with code, and has the LLM
//      write findings from the counts; saved as <result>.analysis.json
//   2. ads-report.mjs renders the page, analysis included
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze, llmConfig } from '../analyze.mjs';

const [src, dest] = process.argv.slice(2);
if (!src) { console.error('usage: node scripts/ads-pipeline.mjs <result.json> [out.html]'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const result = raw.job?.result ?? raw.result ?? raw;

const providers = llmConfig();
console.error(providers.length ? `models: ${providers.map((p) => `${p.model} at ${new URL(p.url).host}`).join(', then ')}` : 'no model set up: counts only');
let analysis;
try {
  analysis = await analyze(result, { providers, log: (m) => console.error(m) });
} catch (e) {
  analysis = { createdAt: new Date().toISOString(), labels: {}, counts: null, written: null, problems: [`the analysis failed: ${e.message}`] };
}
const anFile = src.replace(/\.json$/i, '') + '.analysis.json';
fs.writeFileSync(anFile, JSON.stringify(analysis, null, 1));
console.error(`analysis: ${anFile} (${Object.keys(analysis.labels ?? {}).length} ads labelled, ${(analysis.problems ?? []).length} problems)`);
for (const p of analysis.problems ?? []) console.error(`  - ${p}`);

const report = path.join(import.meta.dirname, 'ads-report.mjs');
execFileSync(process.execPath, [report, src, ...(dest ? [dest] : [])], { stdio: 'inherit' });
